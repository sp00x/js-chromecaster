let socket = io.connect();

// Vue.use(VueMaterial);

let app = new Vue({
    el: '#app',
    data:
    {
        deviceMenu: false,
        devices: [],

        selectedDeviceId: null,
        selectedDevice: null,

        selectedFile: null,

        dir: {
            cwd: [],
            files: [],
            path: ''
        },
        cc: {
            state: 'IDLE',
            duration: 0,
            currentTime: 0,
            volume: 0,
            muted: false,
            width: 0,
            height: 0,
            title: '??'
        },
        previewTime: null,
        chromecastStatus: null,
        chromecastStatusTime: null,
        
        fakeTimerDelta: 0,
        fakeTimerStartTime: null,
        fakeInterval: null
    },
    computed: {
        currentTime()
        {
            return this.previewTime != null ? this.previewTime : this.cc.currentTime + this.fakeTimerDelta;
        }
    },
    mounted()
    {
        this.selectedDeviceId = localStorage.getItem('deviceId');
    },
    methods:
    {
        toggleDeviceMenu()
        {
            this.deviceMenu = !this.deviceMenu;
        },

        getIcon(item)
        {
            return (item.type == 'dir') ? "folder" : "file";
        },
        getIconClass(item)
        {
            if (item.type == 'dir')
                return 'grey lighten-1 white--text'
            else
                return 'blue white--text';
        },




        setFakeTimer(t)
        {
            this.fakeTimerDelta = t;
            console.log("fake: %s + %s = %s", this.cc.currentTime, this.fakeTimerDelta, this.cc.currentTime + this.fakeTimerDelta);
        },
        startFakeTimer()
        {
            let app = this;
            if (this.fakeInterval != null) clearInterval(this.fakeInterval);
            let t0 = this.fakeTimerStartTime = Date.now();
            this.fakeInterval = setInterval(() =>
            {
                app.setFakeTimer((Date.now() - t0) / 1000);
            }, 1000);
        },
        stopFakeTimer()
        {
            if (this.fakeInterval != null) clearInterval(this.fakeInterval);
            this.fakeInterval = null;
        },
        ccPlayPause()
        {
            if (this.cc.state == 'PAUSED')
                socket.emit('chromecast-play');
            else
                socket.emit('chromecast-pause');
        },
        ccPlay()
        {
            socket.emit('chromecast-play');
        },
        ccPause()
        {
            socket.emit('chromecast-pause');
        },
        ccStatus()
        {
            socket.emit('chromecast-status');
        },
        ccStop()
        {
            socket.emit('chromecast-stop');
        },
        seek()
        {
            this.previewTime = null;
            let t = parseFloat(document.getElementById("timeSlider").value);
            console.log("seek: %s", t);
            socket.emit('chromecast-seek', t);
        },
        seekPreview()
        {
            this.stopFakeTimer();
            let t = parseFloat(document.getElementById("timeSlider").value);
            this.previewTime = t;
            console.log("scrub: %s", t);
        },
        setStatus(status)
        {
            if (status != null)
            {
                if (status.playerState == 'PLAYING')
                    this.startFakeTimer();
                else
                {
                    this.fakeTimerDelta = 0;
                    this.stopFakeTimer();
                }

                this.cc.state = status.playerState;
                this.cc.currentTime = status.currentTime;

                if (status.volume != null)
                {
                    this.cc.volume = status.volume.level;
                    this.cc.muted = status.volume.muted;   
                }

                if (status.videoInfo != null)
                {
                    this.cc.width = status.videoInfo.width;
                    this.cc.height = status.videoInfo.height;   
                }

                if (status.media != null)
                {
                    this.cc.duration = status.media.duration;
                    this.cc.title = status.media.metadata.title;
                }

                this.chromecastStatusTime = Date.now();
                this.chromecastStatus = status;
            }
        },
        formatSize(sz)
        {
            return Math.round(sz / (1024 * 1024)) + ' mb';
        },
        formatTime(t)
        {
            return moment(t).format("YYYY-MM-DD hh:mm:ss");
        },
        formatDuration(t)
        {
            return (typeof t == 'number') ? moment.utc(t * 1000).format("HH:mm:ss") : "??:??:??";
        },
        addDevice(dev)
        {
            this.devices.push(dev);
        },
        setDevices(devs)
        {
            this.devices = devs;
        },
        updateDevices()
        {
            console.log("updating devices..")
            socket.emit('update-devices');
        },
        selectDevice(dev)
        {
            this.selectedDevice = dev;
            this.selectedDeviceId = dev.id;
            localStorage.setItem("deviceId", this.selectedDeviceId);
            this.deviceMenu = false;
        },
        updateDir(dir)
        {
            console.log("updating directory..");
            dir.files = dir.files.filter(f => {
                return (f.type == 'dir' || /\.(avi|mp4|m4v|mkv)$/i.test(f.name))
            });
            this.dir = dir;
            window.history.pushState(null, null, window.location.pathname + '#' + JSON.stringify(dir.cwd));
        },
        cdUp(index)
        {
            console.log("cd up: %s", index);
            socket.emit('cd', this.dir.cwd.slice(0, index + 1));
        },
        selectFile(file)
        {
            var selectedDevice = this.devices.find(d => d.id == this.selectedDeviceId);
            this.selectedFile = file;

            console.log("selected file: %s (%s)", file.name, file.type);
            if (file.type == 'dir')
                socket.emit('cd', this.dir.cwd.concat([ file.name ]));
            else
            {
                if (selectedDevice == null)
                {
                    alert("No device selected");
                }
                else
                {
                    socket.emit('play',
                    {
                        deviceId: this.selectedDeviceId,
                        name: file.name
                    });
                }
            }
        }
    }
})

socket.on('connect', () =>
{
    console.log("connected!");
    socket.emit('list-devices');
    let h = window.location.hash;
    if (/^#/.test(h))
    {
        let cwd = JSON.parse(h.substr(1));
        console.log("got cwd from #hash: %o", cwd);
        socket.emit('cd', cwd);   
    }
    else
    {
        socket.emit('cd', []);   
    }
    socket.emit('chromecast-status');
})

socket.on('log', t => console.log("LOG: %s", t));

socket.on('device-list', devs =>
{
    console.log('device-list: %o', devs);
    app.setDevices(devs);
})

socket.on('new-device', dev =>
{
    console.log('new-device: %o', dev);
    app.addDevice(dev);
})

socket.on('dir', dir =>
{
    console.log("dir: %o", dir);
    app.updateDir(dir);
})

socket.on('chromecast-error', err =>
{
    alert("CHROMECAST ERROR:\n\n" + err);
})

socket.on('chromecast-status', status =>
{
    console.log("chromecast status: %o", status);
    app.setStatus(status);
})
