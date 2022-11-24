"use strict";
var debug = require('debug');
var express = require('express');
var path = require('path');
var url = require('url');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var multipart = require('connect-multiparty');
var multiparty = multipart({ uploadDir: './tmp' });
var flow = require('./res/flow-node.js')('tmp');
var utilities = require('./res/utilities.js');
var guid = require('guid');
var extend = require('extend');
var ejs = require('ejs');
var app = express();
var root = process.cwd();
var assert = require('assert');
var crypto = require('crypto');
var moment = require('moment');
var zip = require('express-zip');
var filesize = require('filesize');

require('dotenv').config();

var Directories = require('./res/directories.js');

var accounts;
var shortcuts;

const USERID_ANONYMOUS = '00000000-0000-0001-0005-000000000007';

var config = {
    identity: {
        appname: 'DSFoundryB2BWebPoC.online'
    },
    path: {
        approot: process.cwd(),
        page: {
            default: {
                browseMailStorage: path.join(root, 'res/browsemailstorage.ejs'),
                manageMailStorage: path.join(root, 'res/managemailstorage.ejs'),
                activateAccount: path.join(root, 'res/activateaccount.ejs'),
                send2mail: path.join(root, 'res/home.htm'),
                send2channel: path.join(root, 'res/home.htm'),
                emailactivation: path.join(root, 'res/activate.htm')
            }
        },
        uploaded: '/azblob/'
    }

};

var context = {
    db: null
};

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));

var handlers = {
    signOut: function (req, res) {
        var email = req.params.email;
        res.cookie('k', '', { expires: new Date(1), path: '/' + email });
        res.status(200).send('OK');
    },

    setRecipient: function (req, res) {

        renderBrowsePage({
            email: '',
            sessionid: '',
            isactivated: false
        }, function (html) {
            res.send(html);
        });

    },

    browse: function (req, res) {
        
        if (!req.cookies.k) {

            res.status(200).send('no credential');
            return;

        }
        
        var signinkey = utilities.getKeyFromString(req.cookies.k);
        var email = utilities.getEmailFromString(req.params.email);
        var account = accounts.get(email);
        var host = req.headers.host;

        if (!account) {
            res.status(200).send('no account');
            return;
        }

        if (!account.verifySignInKey(signinkey)) {
            res.status(200).send('wrong key');
            return;
        }

        var assets = shortcuts.getByOwnerUserId(account.owneruserid);
        if (!assets || assets.length == 0) {
            res.status(200).send('no asset');
            return;
        }

        var result = Object.keys(assets).map(function (shortcutkey) {
            let shortcut = assets[shortcutkey];
            let uri = url.resolve(host, 'd/' + shortcutkey);
            return {
                originalname: shortcut.originalname,
                destination: uri,
                createddate: shortcut.createddate,
                contentlength: shortcut.contentlength
            };
        });
        res.json(result);
        
        return;
    },

    homeForUpload: function (req, res) {
        if (req.query.upload_token) {
            console.log('request_getupload: ' + req.originalUrl);
            onRequestGetUpload(req, res);
        } else {
            console.log('request_homeForSendToMail: ' + req.originalUrl);
            
            renderBrowsePage({
                email: "",
                sessionid: utilities.generateId(),
                isactivated: false
            }, function (html) {
                res.status(200).send(html);
            });

        }
    },
    homeForSendToChannel: function (req, res) {
        console.log('request_homeForSendToChannel: ' + req.originalUrl);
        res.sendFile(config.path.page.default.send2channel);
    },
    file: function (req, res) {
        console.log('request_file: ' + req.originalUrl);
        res.sendFile(config.paths.sendToMail);
    },
    upload: function (req, res) {
        console.log('request_upload: ' + req.originalUrl);
        uploadFiles(req, res);
    },
    httpOptions: function (req, res) {
        console.log('request_httpOptions: ' + req.originalUrl);
        res.status(200).send();
    },
    uploadOptions: function (req, res) {
        console.log('request_uploadOptions: ' + req.originalUrl);
        res.status(200).send();
    },
    flowId: function (req, res) {
        console.log('request_flowId: ' + req.originalUrl);
        flow.write(req.params.identifier, res);
    },
    ticket: function (req, res) {
        res.status(200).send(guid.raw());
    },
    download: function (req, res) {
        downloadFile(req, res);
    }
};

var transactionMap = {};

function renderHTMLforShortcuts(shortcutList) {

    var html = '<ul>';

    for (var shortcutkey in shortcutList) {
        var shortcut = shortcutList[shortcutkey];
        html += '<li><span class="file-name">' + shortcut.originalname + '</span></li>';
    }

    html += '</ul>';
    return html;
}

function renderBrowsePage(props, callback) {

    return ejs.renderFile(config.path.page.default.browseMailStorage, props, {}, function (err, str) {
        if (typeof callback === 'function') {
            callback.call(ejs, str);
        }
    });

}

function getTransactionByTransactionId(key) {

    if (typeof key === 'undefined') return;

    var item = transactionMap[key];

    if (typeof item === 'undefined') {

        item = transactionMap[key] = {
            length: 0,
            remains: 0
        };

    }

    return item;

}

function setTransactionByTransactionId(key, length) {

    if (typeof key === 'undefined') return;
    if (typeof length === 'undefined') return;

    var item = getTransactionByTransactionId(key);

    if (item.length == 0) {
        item.remains = length;
    }

    item.length = length;

    return;

}

function removeItemByTransactionId(key) {

    if (typeof key === 'undefined') return;

    if (typeof transactionMap[key] !== 'undefined') {
        transactionMap[key] = undefined;
    }

}

function completeTransactionItem(key) {

    if (typeof key === 'undefined') return;

    var item = getTransactionByTransactionId(key);

    item.remains -= 1;

    if (item.remains <= 0) {

        removeItemByTransactionId(key);
        return true;

    }

    return false;

}

function downloadFile(req, res) {

    var rawkey = req.params.key;
    var realkey = utilities.getKeyFromString(rawkey);
    if (typeof realkey === 'undefined') {
        res.status(500).send('The access key is invalid');
        return;
    }

    var shortcut = shortcuts.get(realkey);
    if (!shortcut) {
        console.error('Error while processing a request for the file - no access key available (%s)', realkey);
        res.status(404).send();
        return;
    }

    if (!shortcut.destination) {
        console.error('Error while processing a request for the file - no file (%s)', realkey);
        res.status(500).send();
        return;

    }

    if (shortcut.originalname) {
        res.setHeader('Content-Disposition', 'attachment; filename=' + encodeURI(shortcut.originalname));
    }

    res.setHeader('Content-Transfer-Encoding', 'binary');
    res.setHeader('Content-Type', 'application/octet-stream');

    switch (shortcut.contenttype) {
        case 'file':
            res.sendFile(path.join(config.path.approot, shortcut.destination));
            break;
        default:
            res.status(500).send();
            break;
    }
    return;
}

function uploadFiles(req, res) {

    flow.post(req, function (status, filename, original_filename, identifier) {

        var sid = req.body.sid || utilities.generateId();
        var tid = req.body.tid || utilities.generateId();
        var tlen = req.body.tlen || 1;
        var mail = utilities.getEmailFromRequest(req);

        setTransactionByTransactionId(tid, tlen);

        var udir = config.path.uploaded;
        console.log('SID: %s, TID: %s, DID: %s)', sid, tid, directory.directoryid);

        if (status == 'done') {

            var upath = path.join(udir, filename);
            var stream = fs.createWriteStream(upath);

            stream.on('finish', function () {

                res.status(200).send();
                flow.clean(identifier);

                if (completeTransactionItem(tid)) {
                    //notify_uploadCompletion(account, sid, {host: req.headers.host});
                    renderCompletedUpload(directory);
                }

            });

            flow.write(identifier, stream/*, { onDone: flow.clean }*/);
    

        }
        else if (status == 'partly_done') {

            res.status(200).send();

        }

    });

}

function onRequestGetUpload(req, res) {

    flow.get(req, function (status, filename, original_filename, identifier) {

        console.log('onRequestGetUpload: ' + req.originalUrl);
        console.log('onRequestGetUpload (%s, %s, %s, %s)', status, filename, original_filename, identifier);

        if (status == 'found') {
            status = 200;
        } else {
            status = 204;
        }

        res.status(status).send();
    });

}

var run = async function () {

    app.set('port', process.env.PORT || 80);

    app.use(cookieParser());
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use('/css', express.static('css'));
    app.use('/img', express.static('img'));
    app.use('/js', express.static('js'));

    app.get('/', handlers.homeForUpload);
    app.post('/', multiparty, handlers.upload);
    app.options('/', handlers.uploadOptions);

    // catch 404 and forward to error handler
    app.use(function (req, res, next) {
        var err = new Error('Not Found');
        console.log('404 NOT FOUND - %s', req.url);
        err.status = 404;
        next(err);
    });

    // error handlers
    // development error handler
    // will print stacktrace
    if (app.get('env') === 'development') {
        app.use(function (err, req, res, next) {
            res.status(err.status || 500);
            res.render('error', {
                message: err.message,
                error: err
            });
        });
    }
    /*
    // production error handler
    // no stacktraces leaked to user
    app.use(function (err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: {}
        });
    });
    */

    var server = app.listen(app.get('port'), function () {
		console.log('server listening on port ' + server.address().port);
	});
};

function renderCompletedUpload(directory, account) {

    assert.strictEqual('object', typeof directory);

    directory.browse(function (err, results) {

        console.dir(results);

    });

}

async function initialize() {

    directories = new Directories(config, null);

}

(async function main() {

    await initialize();
    run();

})();