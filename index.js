// https://www.npmjs.com/package/ffprobe

const sprintf = require('sprintf');
const Browser = require('chromecast-api').Browser;
const Express = require('express');
const HTTP = require('http');
const IP = require('ip');
const Path = require('path');
const URL = require('url');

const CastV2Client  = require("castv2-client");
const Client = CastV2Client.Client;
const DefaultMediaReceiver = CastV2Client.DefaultMediaReceiver;

const SocketIO = require('socket.io');
const OS = require('os');
const FS = require('fs');

let isWindows = OS.type() == 'Windows_NT';
let DriveLetters;
try {
    DriveLetters = require('windows-drive-letters');
} catch (e) {
    isWindnows = false;
}

const config = {
    httpPort: 52810
}

let devices = {};

let url = 'http://' + IP.address() + ':' + config.httpPort + '/play.mp4';
let selectedFilePath = null;
const app = Express();
const server = HTTP.Server(app);
const io = SocketIO(server);

function log(s, ...args)
{
    let allArgs = [s].concat(args);
    let tx = (typeof s == 'object') ? JSON.stringify(s) : sprintf.apply(this, allArgs);
    console.log(tx);
    io.emit('log', tx);
}

app.get('/play.mp4', (req, res, next) =>
{
    log("playing: %s", selectedFilePath);

    if (selectedFilePath == null)
        res.status(404).end();
    else
        res.sendFile(selectedFilePath);
});
app.use('/lib/vue', Express.static(Path.join(__dirname, 'node_modules/vue/dist')));
app.use('/lib/vue-material', Express.static(Path.join(__dirname, 'node_modules/vue-material/dist')));
app.use('/lib/font-awesome', Express.static(Path.join(__dirname, 'node_modules/font-awesome')));
app.use('/lib/moment', Express.static(Path.join(__dirname, 'node_modules/moment')));
app.use('/', Express.static(Path.join(__dirname, 'wwwroot')));
server.listen(config.httpPort);

let client = null, player = null, lastStatus = null;

io.on('connection', socket => 
{
    let cwd = [];

    const getFullPath = () =>
    {
        return Path.join.apply(Path, cwd.map((v, i) => { return i > 0 ? v : v + '\\' }));        
    };

    const emitDir = () =>
    {
        if (cwd.length == 0 && isWindows)
        {
            log("listing drive letters..");
            DriveLetters.usedLetters()
            .then(letters =>
            {
                socket.emit('dir', {
                    cwd: cwd,
                    files: letters.map(letter =>
                    {
                        return { name: letter + ':', type: 'dir' }
                    })
                })
            })
            .catch(err =>
            {
                log("ERROR: Error listing drive letters: " + err);
                socket.emit('dir', {
                    cwd: cwd,
                    files: [ { name: 'ERROR', type: 'dir' } ]
                });
            })
        }
        else
        {
            log(cwd);
            let fullPath = getFullPath();
            log("full path is: %s", fullPath);
            let files;
            try
            {
                files = FS.readdirSync(fullPath);
                files = files.map(name =>
                {
                    try
                    {
                        let s = FS.statSync(Path.join(fullPath, name));
                        return {
                            name: name,
                            sz: s.size,
                            mtime: s.mtimeMs,
                            type: s.isFile() ? 'file' : 'dir'
                        }
                    }
                    catch (e) 
                    {
                        return null;
                    }
                })
                .filter(f => f != null)
                .sort((a, b) =>
                {
                    let r = a.type.localeCompare(b.type);
                    return r == 0 ? a.name.localeCompare(b.name) : r;
                });
            }
            catch (e)
            {
                log("ERROR: error listing directory: " + fullPath + ':  ' + e);
            }
            socket.emit('dir',
            {
                cwd: cwd,
                files: files
            })
        }
    }

    log('new socket connection');

    socket.on('disconnect', () =>
    {
        log("socket disconnected");
    })

    socket.on('cd', newCwd =>
    {
        cwd = newCwd;
        emitDir();
    })

    socket.on('dir', () =>
    {
        emitDir();
    })

    socket.on('list-devices', () =>
    {
        let devsList = [];
        for (let id in devices)
        {
            let device = devices[id];
            devsList.push({ id: id, name: device.config.name, host: device.host });
        }
        socket.emit('device-list', devsList);
    })

    socket.on('update-devices', () =>
    {
        updateDevices();
    })

    function emitChromecastError(err)
    {
        socket.emit('chromecast-error', { message: err.message });
    }

    function emitChromecastStatus(status)
    {
        socket.emit('chromecast-status', status);
    }

    function handleCommon(err, status, errorMessage)
    {
        if (err)
        {
            log("ERROR: %s: %s", errorMessage, err.message);
            emitChromecastError(err);
        }
        else
        {
            emitChromecastStatus(status);
        }
    }

    socket.on('chromecast-pause', () =>
    {
        if (player != null)
        {
            log("pausing player..");
            player.pause((err, status) =>
            {
                handleCommon(err, status, "error pausing player")
            });    
        }
    })

    socket.on('chromecast-play', () =>
    {
        if (player != null)
        {
            log("stopping player..");
            player.play((err, status) =>
            {
                handleCommon(err, status, "error starting player");
            });    
        }
    })

    socket.on('chromecast-stop', () =>
    {
        if (player != null)
        {
            log("stopping player..");
            player.stop((err, status) =>
            {
                handleCommon(err, status, "error stopping player")
            });    
        }
    })

    socket.on('chromecast-seek', t =>
    {
        if (player != null)
        {
            log("seeking to %s ..", t);
            player.seek(t, (err, status) =>
            {
                handleCommon(err, status, "error while seeking")
            })    
        }
    })

    socket.on('chromecast-status', () =>
    {
        if (player != null)
        {
            log("requesting status..");
            player.getStatus((err, status) =>
            {
                handleCommon(err, status, "error while requesting status")
            })    
        }
    })

    socket.on('play', file =>
    {
        log(file);
        let device = devices[file.deviceId];
        let fn = Path.join(getFullPath(), file.name);
        log("play %s / %s on %s", fn, url, device.config.name);
        selectedFilePath = fn;

        log("connecting to device..");
        client = new Client();
        player = null;
        client.connect(device.host, () =>
        {
            log("device connected, launching player..");
            client.launch(DefaultMediaReceiver, (err, player_) =>
            {
                if (err == null)
                {
                    player = player_;
                    player.on('status', status =>
                    {
                        log("---- status ----");
                        log(status);
                        io.emit('chromecast-status', status);
                    })
                    log("loading media..");
                    player.load({
                        contentId: url,
                        contentType: 'video/mp4',
                        streamType: 'BUFFERED',
                        metadata: {
                            type: 0, // deprecated
                            metadataType: 0, // https://developers.google.com/cast/docs/reference/chrome/chrome.cast.media#.MetadataType
                            title: file.name,
                            images: [
                                {
                                    // https://developers.google.com/cast/docs/reference/chrome/chrome.cast.Image
                                    url:  'http://placekitten.com/' + (200 + Math.floor(100 * Math.random())) + '/' + (200 + Math.floor(100 * Math.random())) 
                                }
                            ]
                        }
                    },
                    { autoplay: true },
                    (err, status) => {
                        log("loaded: err=%s, status=%s", err, JSON.stringify(status));
                        io.emit('chromecast-status', status);
                    }
                    )
                }
                else
                {
                    log("ERROR: error launching player: %s", err.message);
                    player.emit('chromecast-error', { message: err.message });    
                }
            })
        })
        
        client.on('error', err =>
        {
            log("ERROR: device error: %s", err);
            io.emit('chromecast-error', { message: err.message });
        });

        /*

        device.play(url, 0, () => {
            console.log("playing..");

            device.getStatus((status) => {
                console.dir(status);
            })
        })

        */
    })
})

function addDevice(device)
{
    let id = device.config.name + '|' + device.host;
    log("found device: %s", device.config.name);
    devices[id] = device;
    io.emit('new-device', { id: id, name: device.config.name, host: device.host });
}

function updateDevices()
{
    log("scanning for devices..");
    const browser = new Browser();
    devices = {};
    io.emit('device-list', []);
    let deviceAdded = (dev) =>
    {
        addDevice(dev);
    }; 
    browser.on('deviceOn', deviceAdded);
}

updateDevices();