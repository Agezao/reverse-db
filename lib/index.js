var Sequelize = require('sequelize');
var async = require('async');
var fs = require('graceful-fs-extra');
var path = require('path');
var mkdirp = require('mkdirp');
var dialects = require('./dialects');
var _ = Sequelize.Utils._;
var SqlString = require('./sql-string');
var CLIEngine = require('eslint').CLIEngine;

function AutoReverseDb(database, username, password, options) {
  if (options && options.dialect === 'sqlite' && ! options.storage)
    options.storage = database;

  if (database instanceof Sequelize) {
    this.sequelize = database;
  } else {
    this.sequelize = new Sequelize(database, username, password, options || {});
  }

  this.queryInterface = this.sequelize.getQueryInterface();
  this.tables = {};
  this.foreignKeys = {};
  this.dialect = dialects[this.sequelize.options.dialect];

  this.options = _.extend({
    global: 'Sequelize',
    local: 'sequelize',
    spaces: false,
    indentation: 1,
    directory: './models',
    additional: {},
    freezeTableName: true,
    typescript: false,
    camelCaseForFileName: false
  }, options || {});
}

AutoReverseDb.prototype.build = function(callback) {
  var self = this;

  function mapTable(table, _callback){
    self.queryInterface.describeTable(table, self.options.schema).then(function(fields) {
      self.tables[table] = fields
      _callback();
    }, _callback);
  }

  if (self.options.dialect === 'postgres' && self.options.schema) {
    var showTablesSql = this.dialect.showTablesQuery(self.options.schema);
    self.sequelize.query(showTablesSql, {
      raw: true,
      type: self.sequelize.QueryTypes.SHOWTABLES
    }).then(function(tableNames) {
      processTables(_.flatten(tableNames))
    }, callback);
  } else {
    this.queryInterface.showAllTables().then(processTables, callback);
  }

  function processTables(__tables) {
    if (self.sequelize.options.dialect === 'mssql')
      __tables = _.map(__tables, 'tableName');

    var tables;

    if      (self.options.tables)     tables = _.intersection(__tables, self.options.tables)
    else if (self.options.skipTables) tables = _.difference  (__tables, self.options.skipTables)
    else                              tables = __tables

    async.each(tables, mapForeignKeys, mapTables);

    function mapTables(err) {
      if (err) console.error(err)

      async.each(tables, mapTable, callback);
    }
  }

  function mapForeignKeys(table, fn) {
    if (! self.dialect) return fn()

    var sql = self.dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {
      type: self.sequelize.QueryTypes.SELECT,
      raw: true
    }).then(function (res) {
      _.each(res, assignColumnDetails)
      fn()
    }, fn);

    function assignColumnDetails(ref) {
      // map sqlite's PRAGMA results
      ref = _.mapKeys(ref, function (value, key) {
        switch (key) {
        case 'from':
          return 'source_column';
        case 'to':
          return 'target_column';
        case 'table':
          return 'target_table';
        default:
          return key;
        }
      });

      ref = _.assign({
        source_table: table,
        source_schema: self.sequelize.options.database,
        target_schema: self.sequelize.options.database
      }, ref);

      if (! _.isEmpty(_.trim(ref.source_column)) && ! _.isEmpty(_.trim(ref.target_column))) {
        ref.isForeignKey = true
        ref.foreignSources = _.pick(ref, ['source_table', 'source_schema', 'target_schema', 'target_table', 'source_column', 'target_column'])
      }

      if (_.isFunction(self.dialect.isUnique) && self.dialect.isUnique(ref))
        ref.isUnique = true

      if (_.isFunction(self.dialect.isPrimaryKey) && self.dialect.isPrimaryKey(ref))
        ref.isPrimaryKey = true

       if (_.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(ref))
         ref.isSerialKey = true

      self.foreignKeys[table] = self.foreignKeys[table] || {};
      self.foreignKeys[table][ref.source_column] = _.assign({}, self.foreignKeys[table][ref.source_column], ref);
    }
  }
}

AutoReverseDb.prototype.run = function(callback) {
  var self = this;
  var text = {};
  var tables = [];
  var typescriptFiles = ['', ''];

  this.build(generateText);

  function generateText(err) {
    var quoteWrapper = '"';
    if (err) console.error(err)

    async.each(_.keys(self.tables), function(table, _callback){
      var fields = _.keys(self.tables[table])
        , spaces = '';

      for (var x = 0; x < self.options.indentation; ++x) {
        spaces += (self.options.spaces === true ? ' ' : "\t");
      }

      var tableName = self.options.camelCase ? _.camelCase(table) : table;

      text[table] = "const " + tableName + " = {\n";

      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = self.foreignKeys[table] && self.foreignKeys[table][field] ? self.foreignKeys[table][field] : null

        if (_.isObject(foreignKey)) {
          self.tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(self.tables[table][field]);
        var fieldName = self.options.camelCase ? _.camelCase(field) : field;
        text[table] += spaces + "'" + fieldName + "': null";

        // Serial key for postgres...
        var defaultVal = self.tables[table][field].defaultValue;

        _.each(fieldAttr, function(attr, x){
          if (attr === "foreignKey") {
            if (foreignKey.isForeignKey) {
              text[table] += ",";
              text[table] += "\n";

              text[table] += spaces + "'" + self.tables[table][field][attr].foreignSources.target_table + "': {}"
              text[table] += ",";
              text[table] += "\n";
            }
          }
        });

        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '');

        //text[table] += spaces + spaces + "}";
        if ((i+1) < fields.length) {
          text[table] += ",";
        }
        text[table] += "\n";
      });

      text[table] += "}\n\n";

      //resume normal output
      text[table] += "module.exports = Object.assign({}, " + tableName + ");";
      _callback(null);
    }, function(){
      self.sequelize.close();

      if (self.options.directory) {
        return self.write(text, typescriptFiles, callback);
      }
      return callback(false, text);
    });
  }
};

AutoReverseDb.prototype.write = function(attributes, typescriptFiles, callback) {
  var tables = _.keys(attributes);
  var self = this;

  mkdirp.sync(path.resolve(self.options.directory));

  async.each(tables, createFile, !self.options.eslint ? callback : function() {
    var engine = new CLIEngine({ fix: true });
    var report = engine.executeOnFiles([self.options.directory]);
    CLIEngine.outputFixes(report);
    callback();
  });

  if (self.options.typescript) {
    if (typescriptFiles !== null && typescriptFiles.length > 1) {
      fs.writeFileSync(path.join(self.options.directory, 'db.d.ts'), typescriptFiles[0], 'utf8');
      fs.writeFileSync(path.join(self.options.directory, 'db.tables.ts'), typescriptFiles[1], 'utf8');
    }
  }

  function createFile(table, _callback) {
    var fileName = self.options.camelCaseForFileName ? _.camelCase(table) : table;
    fs.writeFile(path.resolve(path.join(self.options.directory, fileName + (self.options.typescript ? '.ts' : '.js'))), attributes[table], _callback);
  }
};

module.exports = AutoReverseDb;
