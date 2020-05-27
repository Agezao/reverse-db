# Reverse Db

Automatically generate JSON models for Relational DBs (MSSQL, MariaDB, MySQL, Postgres, Sqlite) via the command line.

## Install

    npm install -g reverse-db

## Prerequisites

You will need to install the correct dialect binding globally before using reverse-db.

Example for MySQL/MariaDB

`npm install -g mysql`

Example for Postgres

`npm install -g pg pg-hstore`

Example for Sqlite3

`npm install -g sqlite`

Example for MSSQL

`npm install -g mssql`

## Usage

    [node] reverse-db -h <host> -d <database> -u <user> -x [password] -p [port]  --dialect [dialect] -c [/path/to/config] -o [/path/to/models] -t [tableName] -C

    Options:
      -h, --host        IP/Hostname for the database.   [required]
      -d, --database    Database name.                  [required]
      -u, --user        Username for database.
      -x, --pass        Password for database.
      -p, --port        Port number for database.
      -o, --output      What directory to place the models.
      -e, --dialect     The dialect/engine that you're using: postgres, mysql, sqlite

## Example

    reverse-db -o "./models" -d test -h localhost -u my_username -p 5432 -x my_password -e postgres

Produces a file/files such as ./models/SkillLevels.js which looks like:

    /* jshint indent: 2 */

    const SkillLevels = {
      'id': null,
      'name': null,
      'createdAt': null,
      'updatedAt': null
    }

    module.exports = Object.assign({}, SkillLevels);


Which makes it easy for you to simply import and use it.


---

This project was based on [Sequelize-Auto](https://github.com/sequelize/sequelize-auto)
