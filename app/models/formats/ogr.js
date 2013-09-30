
var crypto      = require('crypto')
var Step        = require('step')
var fs          = require('fs')
var _           = require('underscore')
var PSQL        = require(global.settings.app_root + '/app/models/psql')
var spawn       = require('child_process').spawn

// Keeps track of what's waiting baking for export
var bakingExports = {};

// Return database username from user_id
// NOTE: a "null" user_id is a request to use the public user
function userid_to_dbuser(user_id) {
  if ( _.isString(user_id) )
      return _.template(global.settings.db_user, {user_id: user_id});
  return global.settings.db_pubuser;
};



function ogr(id) {
  this.id = id;
}

ogr.prototype = {

  id: "ogr",

  is_file: true,

  getQuery: function(sql, options) {
    return null; // dont execute the query
  },

  transform: function(result, options, callback) {
    throw "should not be called for file formats"
  },

  getContentType: function(){ return this._contentType; },

  getFileExtension: function(){ return this._fileExtension; },

  getKey: function(options) {
    return [this.id,
        options.dbname,
        options.user_id,
        options.gn,
        this.generateMD5(options.filename),
        this.generateMD5(options.sql)].concat(options.skipfields).join(':');
  },

  generateMD5: function (data){
    var hash = crypto.createHash('md5');
    hash.update(data);
    return hash.digest('hex');
  }

};

// Internal function usable by all OGR-driven outputs
ogr.prototype.toOGR = function(dbname, user_id, db_hostname, gcol, sql, skipfields, out_format, out_filename, out_layername, callback) {
  var ogr2ogr = 'ogr2ogr'; // FIXME: make configurable
  var dbhost = db_hostname;
  var dbport = global.settings.db_port;
  var dbuser = userid_to_dbuser(user_id);
  var dbpass = ''; // turn into a parameter..

  var that = this;

  var columns = [];
  var geocol;
  var pg;

  // Drop ending semicolon (ogr doens't like it)
  sql = sql.replace(/;\s*$/, ''); 

  Step (

    function fetchColumns() {
      var colsql = 'SELECT * FROM (' + sql + ') as _cartodbsqlapi LIMIT 1';
      pg = new PSQL(user_id, dbname, dbhost, 1, 0);
      pg.query(colsql, this);
    },
    function findSRS(err, result) {
      if (err) throw err;

      //if ( ! result.rows.length ) throw new Error("Query returns no rows");

      var needSRS = that._needSRS;

      // Skip system columns, find geom column
      for (var i=0; i<result.fields.length; ++i) {
        var field = result.fields[i];
        var k = field.name;
        if ( skipfields.indexOf(k) != -1 ) continue;
        if ( out_format != 'CSV' && k == "the_geom_webmercator" ) continue; // TODO: drop ?
        if ( out_format == 'CSV' ) columns.push(pg.quoteIdentifier(k)+'::text');
        else columns.push(pg.quoteIdentifier(k));

        if ( needSRS ) {
          if ( ! geocol && pg.typeName(field.dataTypeID) == 'geometry' ) {
            geocol = k
          }
        }
      }
      //console.log(columns.join(','));

      if ( ! needSRS || ! geocol ) return null;

      var next = this;

      var qgeocol = pg.quoteIdentifier(geocol);
      var sridsql = 'SELECT ST_Srid(' + qgeocol + ') as srid, GeometryType(' +
                   qgeocol + ') as type FROM (' + sql + ') as _cartodbsqlapi WHERE ' +
                   qgeocol + ' is not null limit 1';

      pg.query(sridsql, function(err, result) {
        if ( err ) { next(err); return; }
        if ( result.rows.length ) {
          var srid = result.rows[0].srid;
          var type = result.rows[0].type;
          next(null, srid, type);
        }
      });

    },
    function spawnDumper(err, srid, type) {
      if (err) throw err;

      var next = this;

      var ogrsql = 'SELECT ' + columns.join(',')
          + ' FROM (' + sql + ') as _cartodbsqlapi';

      var ogrargs = [
        '-f', out_format,
        '-lco', 'ENCODING=UTF-8',
        '-lco', 'LINEFORMAT=CRLF',
        out_filename,
        "PG:host=" + dbhost
         + " port=" + dbport
         + " user=" + dbuser
         + " dbname=" + dbname
         + " password=" + dbpass
         + " tables=fake" // trick to skip query to geometry_columns (private)
                          // in turn breaks knowing SRID with gdal-0.10.1:
                          // http://github.com/CartoDB/CartoDB-SQL-API/issues/110
         + "",
        '-sql', ogrsql
      ];

      if ( srid ) {
        ogrargs.push('-a_srs', 'EPSG:'+srid);
      }

      if ( type ) {
        ogrargs.push('-nlt', type);
      }

      ogrargs.push('-nln', out_layername);

      var child = spawn(ogr2ogr, ogrargs);

/*
console.log('ogr2ogr ' + _.map(ogrargs, function(x) { return "'" + x + "'"; }).join(' '));
*/

      var stdout = '';
      child.stdout.on('data', function(data) {
        stdout += data;
        //console.log('stdout: ' + data);
      });

      var stderr;
      var logErrPat = new RegExp(/^ERROR/);
      child.stderr.on('data', function(data) {
        data = data.toString(); // know of a faster way ?
        // Store only the first ERROR line
        if ( ! stderr && data.match(logErrPat) ) stderr = data;
        console.log('ogr2ogr stderr: ' + data);
      });

      child.on('exit', function(code) {
        if ( code ) {
          var emsg = stderr.split('\n')[0];
          // TODO: add more info about this error ?
          //if ( RegExp(/attempt to write non-.*geometry.*to.*type shapefile/i).exec(emsg) )
          next(new Error(emsg));
        } else {
          next(null);
        }
      });
    },
    function finish(err) {
      callback(err, out_filename);
    }
  );
};

// TODO: simplify to take an options object
ogr.prototype.toOGR_SingleFile = function(dbname, user_id, db_hostname, gcol, sql, skipfields, fmt, ext, layername, callback) {
  var tmpdir = global.settings.tmpDir || '/tmp';
  var reqKey = [ fmt, dbname, user_id, gcol, this.generateMD5(layername), this.generateMD5(sql) ].concat(skipfields).join(':');
  var outdirpath = tmpdir + '/sqlapi-' + process.pid + '-' + reqKey;
  var dumpfile = outdirpath + ':cartodb-query.' + ext;

  // TODO: following tests:
  //  - fetch query with no "the_geom" column
  this.toOGR(dbname, user_id, db_hostname, gcol, sql, skipfields, fmt, dumpfile, layername, callback);
};

ogr.prototype.sendResponse = function(opts, callback) {
  var next = callback;
  var reqKey = this.getKey(opts);
  var qElem = new ExportRequest(opts.sink, callback);
  var baking = bakingExports[reqKey];
  if ( baking ) {
    baking.req.push( qElem );
  } else {
    baking = bakingExports[reqKey] = { req: [ qElem ] };
    this.generate(opts, function(err, dumpfile) {
      Step (
        function sendResults() {
          var nextPipe = function(finish) {
            var r = baking.req.shift();
            if ( ! r ) { finish(null); return; }
            r.sendFile(err, dumpfile, function() {
              nextPipe(finish);
            });
          }

          if ( ! err ) nextPipe(this);
          else {
            _.each(baking.req, function(r) {
              r.cb(err);
            });
            return true;
          }
        },
        function cleanup(err) {
          delete bakingExports[reqKey];

          // unlink dump file (sync to avoid race condition)
          console.log("removing", dumpfile);
          try { fs.unlinkSync(dumpfile); }
          catch (e) {
            if ( e.code != 'ENOENT' ) {
              console.log("Could not unlink dumpfile " + dumpfile + ": " + e);
            }
          }
        }
      );
    })
  }
  return;
};

// TODO: put in an ExportRequest.js ----- {

function ExportRequest(ostream, callback) {
  this.cb = callback;
  this.ostream = ostream;
  this.istream = null;
  this.canceled = false;

  var that = this;

  this.ostream.on('close', function() {
    //console.log("Request close event, qElem.stream is " + qElem.stream);
    that.canceled = true;
    if ( that.istream ) {
      that.istream.destroy();
    }
  });
}

ExportRequest.prototype.sendFile = function (err, filename, callback) {
  var that = this;
  if ( ! this.canceled ) {
    //console.log("Creating readable stream out of dumpfile");
    this.istream = fs.createReadStream(filename)
    .on('open', function(fd) {
      that.istream.pipe(that.ostream);
      callback();
    })
    .on('error', function(e) {
      console.log("Can't send response: " + e);
      that.ostream.end(); 
      callback();
    });
  } else {
    //console.log("Response was canceled, not streaming the file");
    callback();
  }
  this.cb();
}

//------ }

module.exports = ogr;
