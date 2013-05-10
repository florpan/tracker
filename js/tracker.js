/* support */
function debug(){
    if(window.console && console.log)
        console.log.call(console,arguments);
}
/* /support */


function Tracker(playerSelector){
    playerSelector = playerSelector || "#player";
    var context = window.webkitAudioContext ? new webkitAudioContext() : new AudioContext(),
        downSample = Math.floor(context.sampleRate/44100); //aim for 44.1k
    var self = this,
        bufferSize = 4096,
        sampleRate = context.sampleRate / downSample,
        oneSampleRate = 1/sampleRate,
        compressor = context.createDynamicsCompressor(),
        analyzer = context.createAnalyser(),
        processor = context.createScriptProcessor(bufferSize),
        filter = context.createBiquadFilter(),
        player = $(playerSelector),
        playerElement = player[0],
        channels = [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
        isPlaying = false,
        tickOffset = 0,
        patternPos = 0,
        rowIndex = 0,
        currentTick = 0,
        speed = 3,
        currentPattern = null,
        visiblePattern = -1,
        minPeriod = 1,
        maxPeriod = 150, //?? ingen aning om vad som är rimligt
        singlePattern = false,
        song = null,
        maxProcessTime = 1000 * bufferSize / sampleRate,
        tickRate = 0,
        updateCallback = null,
        progressCallback = null,
        patternJumpPos = null,
        patternBreakPos = null,
        instrumentInfo = {},
        lagging = false;

    if(downSample != 1)
        debug('sample rate down from ' + context.sampleRate + ' to ' + sampleRate);
    else
        debug('using sample rate ' + sampleRate);

    //init audio
    window._trackerprocessor = processor; //dummmy to keep chrome's GC from interfering
    processor.onaudioprocess = process;
    filter.type=5;
    filter.frequency.value=400;
    filter.Q.value=400;
    filter.gain.value=3;
    analyzer.smoothingTimeConstant = 0.3;
    analyzer.fftSize = 1024;
    processor.connect(filter);
    filter.connect(compressor);
    compressor.connect(analyzer);
    analyzer.connect(context.destination);

    this.getFilter = function() {
      return filter;
    };

    // Public
    this.setDownsample = function(v) {
        if(!isNaN(v)){ // && (v == 1 || v == 2 || v == 4)
            downSample = v;
            sampleRate = Math.round(context.sampleRate / downSample);
            oneSampleRate = 1/sampleRate;
            maxProcessTime = 1000 * bufferSize / sampleRate;
            tickRate = sampleRate*60 / tempo / 4 / 6;
            debug('using sample rate ' + sampleRate);
        } else
            debug('downsample',v,'not supported. 1,2 or 4 accepted');
    }
    var playing = [];
    this.startNote = function(note, inst) {
        playing.push(note);
        var c = playing.length;
        channels[c].inst = inst;
        channels[c].samplepos = 0;
        channels[c].period = note;
        channels[c].mp = note;
        recalc(channels[c]);
    };
    this.endNote = function(note, inst) {
        var c = -1;
        for(var i=0; i<song.ChannelsCount && c<0; i++)
        {
            if(channels[i].mp == note)
                c = i;
        }
        var removed = playing.splice(playing.indexOf(note),1)
        if(c > -1){
            channels[c].mp = null;
            channels[c].period = 96;
            recalc(channels[c]);
        }
    };
    this.isPlaying = function() {return isPlaying;};
    this.onUpdate = function(f){ updateCallback = f;};
    this.onProgress = function(f) { progressCallback = f; }
    this.onLoading = function() { isPlaying = false; };
    this.onLoaded = function(data) {
        debug('loaded');
        channels = [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}];
        isPlaying = false;
        tickOffset = 0;
        patternPos = 0;
        rowIndex = 0;
        currentTick = 0;
        speed = 3,
        currentPattern = null;
        visiblePattern = -1,
        singlePattern = false;
        song = data;
        oneChannel = (1.0/song.ChannelsCount);
        speed = song.InitialSpeed;
        tempo = song.InitialTempo;
        //måste räknas om, men den kan ligga här så länge iom att inga effekter som ändrar hastigheten
        tickRate = sampleRate*60 / tempo / 4 / 6; //byte per sek / beats per min / 4 notes per beat
        song.isLinear = (song.Flags & modFlags.UF_LINEAR) == modFlags.UF_LINEAR;
        song.useXmPeriods = (song.Flags & modFlags.UF_XMPERIODS) == modFlags.UF_XMPERIODS;
        initInstruments();
        initLayout();
        showPattern(song.Positions[0]);
        for(var i=0; i<channels.length; i++)
        {
            channels[i].volume = 1;//TODO: resetta hela klabbet
            channels[i].pan = 0.5;//i & 1;
            channels[i].tremortoggle = 1;
        }
    };

    this.togglePlay = function(){
        isPlaying = !isPlaying;
        notifyChange();
        return isPlaying;
    };
    this.getSong = function() {
        return song;
    };
    this.getChannel = function(i) {
        return channels[i];
    };
    this.setPosition = function(pos){
        rowIndex = 0;
        currentTick = 0;
        tickOffset = 0;
        patternPos = pos;
        showPattern(song.Positions[patternPos]);
        return this;
    };
    this.goto = function(o/*{p:0,r0}*/){
        var pos = -1;
        for(var i=0; i<song.Positions && pos == -1; i++){
            if(song.Positions[i] == o.p)
                pos = i;
        }
        if(i > -1){
            self.setPosition(i);
            rowIndex = o.r;
            scrollPatternTo(rowIndex);
            notifyChange();
        } else {
            console.log('goto failed',o);
        }
    };
    this.setMute = function(positions){
        self.unmuteAll();
        $.each(positions,function(){ self.mute(this);});
        return this;
    };
    this.unmuteAll = function(){
        for(var i=0;i<channels.length; i++) self.unmute(i);
        return this;
    };
    this.muteAll = function(){
        for(var i=0;i<channels.length; i++) self.mute(i);
        return this;
    };
    this.mute = function(channel, val){
        if(val != null && !val)
        {
            self.unmute(channel);
            return this;
        }
        channels[channel].muted = true;
        player.addClass("c" + channel + "disabled");
        return this;
    };
    this.unmute = function(channel){
        channels[channel].muted = false;
        player.removeClass("c" + channel + "disabled");
        return this;
    };
    this.setSinglePattern = function(v) {
        singlePattern = v;
        return this;
    };
    this.getAnalyzerData = function(){
      var arr = new Uint8Array(analyzer.frequencyBinCount);
      analyzer.getByteFrequencyData(arr);
      return arr;
    };
    var handledEffects = /*0,7,20,22,24,25,26*/[1,2,3,4,5,6,8,9,10,11,12,13,14,15,16,17,18,19,21,23, 234,235];
    /*224 + [0-15] Exy */
    this.getEffectSummary = function(onlyUnhandled){
        var out = [], p, t,c;
        try {
        for(p=0; p<song.Patterns.length; p++)
        {
            var pat = song.Patterns[p];
            for(t=0; t<pat.Tracks.length; t++)
            {
                var trk = pat.Tracks[t];
                for(c=0; c<trk.Cells.length; c++)
                {
                    var cell = trk.Cells[c];
                    var fx = cell[0];
                    var fxp = cell[1];
                    if(fx == 14){
                        fx = ((fx << 4)&0xf0) + ((fxp >> 4) & 0x0f);
                    }
                    if( (fx > 0 || (fx == 0 && fxp > 0)) && (!onlyUnhandled || handledEffects.indexOf(fx) < 0)){
                        var d = out[fx];
                        if(!d){
                            d = {n: fx.toString(16).toUpperCase(), fx: fx, w:[]};
                            out[fx] = d;
                        }
                        d.w.push({p:p, r:t,c:c,v:fxp});
                    }
                }
            }
        }
        }catch(err){
            debug('Failed to read at ' + p + ':' + t + ':' + c);
        }

        var o = [];
        $.each(out, function(f){
            f = out[f];
            if(!f)
                return;
            f.count = f.w.length;
            f.avg = 0;
            f.min = 100000;
            f.max = 0;
            $.each(f.w,function(){
                f.avg += this.v;
                f.min = f.min > this.v ? this.v : f.min;
                f.max = f.max < this.v ? this.v : f.max;
            });
            f.avg /= f.count;
            o.push(f);
        });
        return o;

    };
    this.debugInfo = function(){
        var t=0;
        for(var i=0; i<10; i++)
            t += processTimes[i];

        return {avg: t / 10, tot: processedCount };
    }
    // /Public

    function setProgress(info, pos, max){
        if(progressCallback)
            progressCallback(info,pos,max);
    }
    function notifyChange(){
        if(updateCallback)
            updateCallback(patternPos, song.Positions[patternPos], speed, tempo);
    }

    function process(e) {
        var start = window.performance.now();
        var buf=[e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1)];
        var len=e.outputBuffer.length;
        var advanceFn = update;
        if (!isPlaying){
            advanceFn = function(){};
            /*for(var i=0; i<len; i++){
                buf[0][i] = buf[1][i] = 0.0;
            }
            return;*/
        }

        var out=[];
        var last=0;
        var ds = downSample;
        for(var i=0; i<len; i += ds){
            for(var j=last; j<i; j++){ //om nersamplad
                buf[0][j] = out[0];
                buf[1][j] = out[1];
            }
            last = i;
            advanceFn();
            out[0] = out[1] = 0.0;
            for(var c=0; c<song.ChannelsCount; c++)
            {
                var channel = channels[c];
                if(channel.muted)
                    continue;
                if ((channel.inst || channel.inst == 0) && channel.period != 96 && channel.tremortoggle){
                    var instr = song.Instruments[channel.inst];
                    var buffer = instr.WaveData;

                    if (buffer.length > channel.samplepos) {
                        var v = oneChannel* buffer[Math.floor(channel.samplepos)]*channel.volume;

                        out[c&1] += v;
                        channel.samplepos += channel.rate;
                    }

                    if(instr.Samples[0].Flags&sampleFlags.SF_NOLOOP && (channel.samplepos >= buffer.length || (channel.looping && instr.Samples[0].LoopEnd && channel.samplepos >= instr.Samples[0].LoopEnd)))
                    {
                        channel.looping = true;
                        channel.samplepos = instr.Samples[0].LoopStart;
                    }
                }
            }


            var pan = channel.pan, pan2 = 1-pan;
            var t = out[0];
            out[0] = t * pan2 + out[1] * pan;
            out[1] = t * pan + out[1] * pan2;

            if(out[0] < -1 || out[0] > 1 || out[1] < -1 || out[1] > 1){
                isPlaying = false;
                console.log([out[0], out[1]]);
                var b = 1;
            }

            buf[0][i] = out[0];
            buf[1][i] = out[1];
            tickOffset++;
        }

        if((window.performance.now() - start) > maxProcessTime)
        {
            lagging = true;
        }
        //trackProcessTime(window.performance.now() - start);
    }

    var processTimes = [], timingIndex = 0, processedCount =0;
    function trackProcessTime(t){
        processTimes[timingIndex] = t;
        processedCount++;
        timingIndex = (timingIndex + 1)%10;
    }

    function update(){

        if(tickOffset>=tickRate) {
            tickOffset = 0;

            if(patternBreakPos != null || patternJumpPos != null){
                rowIndex = patternBreakPos || 0;
                if(patternJumpPos != null){
                    patternPos = patternJumpPos;
                } else {
                    patternPos++;
                }

                patternBreakPos = null;
                patternJumpPos = null;
                currentTick = 0;
                showPattern(song.Positions[patternPos]);
                notifyChange();
            }
        }
        if (tickOffset == 0) {
            handleTick(currentTick);
            currentTick = (currentTick + 1) % speed;
        }
    }

    function handleTick(tick) {
        currentPattern = song.Patterns[song.Positions[patternPos]];
        if (tick == 0) {

            if (rowIndex >= currentPattern.RowsCount) {
                patternEnded();
                notifyChange();
            }

            for (n = 0; n < song.ChannelsCount; n++) {
                if(channels[n].muted)
                    continue;
                var note = currentPattern.Tracks[n].Cells[rowIndex];
                playNote(n, note);
            }


            scrollPatternTo(rowIndex);
        }
        else {
            for (n = 0; n < song.ChannelsCount; n++) {
                var channel = channels[n];
                if(channel.muted)
                    continue;
                channel.tick = tick;
                updateChannel(n,channel);
            }
        }
        if(tick == speed-1) {
            rowIndex++;
        }
    }

    var one2 = 0.5;
    var one12 = 1/12.0;
    var one16 = 1/16.0;
    var one64 = 1/64.0;
    var one256 = 1/256.0;
    var one768 = 1/768.0;
    function playNote(channelNum, note) {
        var channel = channels[channelNum],
            n = note[NoteData.Note],
            o = note[NoteData.Octave],
            i = note[NoteData.Instrument],
            e = note[NoteData.Effect],
            p = note[NoteData.EffectData],
            pr =note[NoteData.Period];

        channel.tick = 0;

        var tempNote = null;
        var tempFx = channel.fx;
        channel.tick = 0;
        channel.fx = e;
        channel.note = n;

        if (p)
            channel.fxp = p;

        if (i)
            channel.inst = i - 1;

        var instr = song.Instruments[channel.inst];
        if(i && instr){
            channel.volume = instr.Samples[0].Volume * one64;
        }

        if(n != null){
            tempNote = channel.period;
            channel.period = pr;//n != null ? o * 12 + n : -1;
            channel.samplepos = 0;
            channel.looping = false;
            channel.recalc = true;
        }


        if(instr && e == 0){
            //TODO
            channel.arpeggio = {
                base:channel.period,
                lo:getPeriod(n + instr.Samples[0].Transpose + (channel.fxp & 0xf0 >>4), instr.Samples[0].C2Spd),
                hi:getPeriod(n + instr.Samples[0].Transpose + (channel.fxp & 0x0f), instr.Samples[0].C2Spd)};
        } else {
            channel.arpeggio = null;
        }

        if(e == 1 || e == 19){
            channel.slidespeed = ((song.isLinear || e == 19) ? (12*channel.fxp) >> 8 : channel.fxp*one16);
            channel.portTarget = 0;
            //console.log('port up ', channel.fxp);
        } else if(e == 2 || e == 18){
            channel.slidespeed = -((song.isLinear || e == 18) ? (12*channel.fxp) >> 8 : channel.fxp*one16);
            channel.portTarget = 0;
            //console.log('port dn ', channel.fxp);
        } else if ((e == 3 || e == 5) && channel.inst) {//portamento to note
            if(tempNote){ //no note, no new slide. but keep existing
                channel.slidespeed = (song.isLinear || e == 18) ? (12*channel.fxp) >> 8 : channel.fxp*one16;
                if (channel.period < tempNote)//target < source, then reduce
                    channel.slidespeed = -channel.slidespeed;
                //console.log('port to note from',tempNote, 'to', channel.period, 'by', channel.slidespeed);
                channel.portTarget = channel.period;// getPeriod(channel.period + instr.Samples[0].Transpose, instr.Samples[0].C2Spd);
                channel.period = tempNote; //keep old note and slide to it.
            }
        } else {
            channel.slidespeed = 0;
        }

        if(e == 4 || e == 6){//vibrato, vibrato + volslide
            //console.log('setting vibrato ', channel.fxp, channel.fxp.toString(16), (channel.fxp & 0xf0) >> 4    , channel.fxp & 0x0f);
            var s = (channel.fxp & 0xf0) >> 4,
                d = channel.fxp & 0x0f;
            if(s && d){
                channel.vibrato = {
                    speed:s,
                    depth:d,
                    period:channel.period,
                    pos:0};
            }
        } else {
            channel.vibrato = null;
        }

        if (e == 8)
        {
            channel.pan = channel.fxp * one256;
        }

        if (e == 9 || e == 18) // offset
        {
            channel.samplepos = channel.fxp << 8;
        }

        if(e == 10 || e == 17 || e == 5 || e == 6){ //volslide, port+volslide, vibrato+volslide
            if(!p)
                p = channel.fxp;
            if((p&0xf0) == 0)
                channel.volslide = -(p & 0xf);
            else
                channel.volslide = (p & 0xf0) >> 4;
        } else {
            channel.volslide = 0;
        }

        if(e == 11){
            patternJumpPos = p;
         }
        if (e == 12) {
            channel.volume = p * one64;//*= (p || channel.fxp) / 256.0;
        }
        if(e == 13){
            patternBreakPos = p; //p och inte fxp, dvs inte föregående värdet på hopp.
        }
        if(e == 14){
            var mod = (channel.fxp&0xf0) >> 8,
                d= channel.fxp&0x0f;
            if(mod==10) { //ea
                channel.volume += d*one64;
                if(channel.volume >= 1) channel.volume = 1;
            } else if(mod == 11){ //eb
                channel.volume -= d*one64;
                if(channel.volume <= 0) channel.volume = 0;
            }
        }
        if(e == 15 || e == 16 || e == 22){ //skumt med 3 olika speed/bpm..
            if(channel.fxp > 32){
                tempo = channel.fxp;
                tickRate = sampleRate*60 / tempo / 4 / 6;
                notifyChange();
            } else {
                speed = channel.fxp;
            }
        }
        if(e == 21){ //s3m-e
            channel.retrig = channel.fxp;
        } else  {
            channel.retrig = 0;
        }
        if(e == 23){
            channel.tremor = [(channel.fxp & 0xf0) >> 4, channel.fxp & 0xf];
            channel.tremorindex = 0;
            channel.tremortoggle = 1;
        } else {
            channel.tremor = null;
            channel.tremortoggle = 1;
        }

        updateChannel(channelNum, channel);
    }

    function recalc(channel){
        channel.rate = getRate(channel.period, song.Instruments[channel.inst], 0);
        channel.recalc = false;
    }

    function updateChannel(chid, channel) {
        if(channel.slidespeed){
            var p = channel.period,
                inc = channel.slidespeed;
            channel.period += inc;//(10.0*channel.slidespeed) / 256.0; //en oktav per 256 speed

            //console.log('port by', inc, 'from',p,'to', channel.period, '[',channel.portTarget,']');
            if(channel.portTarget){
                if((channel.period <= channel.portTarget && channel.slidespeed < 0) ||
                   (channel.period >= channel.portTarget && channel.slidespeed > 0)){
                    channel.period = channel.portTarget;
                    channel.portTarget = 0;
                    channel.slidespeed = 0;
                    //console.log('port to note ended');
                }
            }
            channel.recalc = true;
        }
        if(channel.retrig && (channel.tick % channel.retrig) == 0){
            debug('retrig ' + channel.retrig);
            channel.samplepos = 0;
        }

        if(channel.volslide){
            var vol = channel.volume + channel.volslide * one64;
            channel.volume = vol < 0 ? 0 : vol > 1 ? 1 : vol;
        }
        if(channel.tremor){
            //console.log('tremor - ',rowIndex, currentTick, channel.tremorindex, channel.tremortoggle);
            if(channel.tremortoggle == 1)
            {
                if(channel.tremorindex == channel.tremor[1]){
                    //  console.log('tremor off',rowIndex, currentTick, channel.tremorindex);
                    channel.tremortoggle = 0;
                    channel.tremorindex = 0;
                } else {
                    channel.tremorindex++;
                }
            } else {
                if(channel.tremorindex == channel.tremor[0]){
                    //console.log('tremor on',rowIndex, currentTick, channel.tremorindex);
                    channel.tremortoggle = 1;
                    channel.tremorindex = 0;
                } else {
                    channel.tremorindex++;
                }
            }
        }

        if(channel.vibrato && channel.tick){
            var pos = channel.vibrato.pos & 0x3f,
                t = VibratoTable[pos]*channel.vibrato.depth*one16;

            channel.period = channel.vibrato.period + t;

            //console.log('vibrato',pos, t, channel.period);
            channel.vibrato.pos += channel.vibrato.speed;
            channel.recalc = true;
        }
/*
        if (channel.portSpeed) {
            //channel.port += channel.portSpeed;
            console.log([rowIndex, tick, 'port', channel.portSpeed, channel.port, channel.portTarget]);
            //channel.period += channel.portSpeed;
            channel.port += channel.portSpeed;
            if (channel.portTarget) {
                //console.log(['check', channel.portSpeed, channel.portTarget, channel.rate]);
                if (channel.portSpeed < 0 && channel.port <= channel.portTarget) {
                    channel.rate = channel.portTarget;
                    channel.portSpeed = 0;
                    console.log(rowIndex, currentTick, 'porta target reached', channel.rate, freq2rate(channel.port));
                }else if (channel.portSpeed > 0 && channel.port >= channel.portTarget) {
                    channel.rate = channel.portTarget;
                    channel.portSpeed = 0;
                    console.log(rowIndex, currentTick, 'porta target reached', channel.rate, freq2rate(channel.port));
                }
            }
            channel.rate = freq2rate(channel.port);//getRate(channel.period, song.Instruments[channel.inst], 0);
        }
*/
        if (channel.recalc) {
            recalc(channel);
        }

    }

    function patternEnded() {
        if (isPlaying) {
            if(singlePattern)
            {
                rowIndex = 0;
                return;
            }
            patternPos++;
            if (patternPos < song.Positions.length) {
                var p = song.Positions[patternPos];
                rowIndex = 0;
                currentPattern = song.Patterns[p];
                showPattern(p);
            } else {
                patternPos = -1;
                isPlaying = false;
            }
        }

    }


    function freq2rate(period) {
        return song.isLinear ? getFreq2(period) * oneSampleRate : (3579546 << 2) / (period * sampleRate);
        //return (song.Flags & modFlags.UF_LINEAR) ? getFreq2(period) / sampleRate : (3579546 << 2) / (period * sampleRate);
    }

    function getRate(note, instr, portamento) {
        /*try {*/
            var period = getPeriod(note + instr.Samples[0].Transpose, instr.Samples[0].C2Spd) + (portamento | 0);
            return freq2rate(period);
        /*} catch (err) {
            debug('getRate', err);
        }*/

        return 0;
    }

    function getFreq2(period)
    {
        period = 7680 - Math.floor(period);
        var okt = Math.floor(period * one768),
            frequency = lintab[period - (okt*768)];
        //var okt = Math.floor(period / 768),
        //    frequency = lintab[period % 768];
        frequency <<= 2;
        return (frequency >> (7 - okt));
    }

    function getPeriod(note, speed) {
        if (song.useXmPeriods)
        {
            return song.isLinear ? getLinearPeriod(note, speed) : getLogPeriod(note, speed);
        }
        return getOldPeriod(note, speed);
    }

    function getLinearPeriod(note, fine) {
        return 7680 - (note * 64) - (fine * one2) + 64;
        //return ((10 * 12 * 16 * 4) - (note * 16 * 4) - (fine / 2) + 64);
    }
    function getLogPeriod(note, fine) {
        var n, o, p1, p2, i;

        o = Math.floor(note * one12);
        n = Math.round(note) -  o*12;

        //n = Math.round(note) % 12;
        //o = Math.floor(note / 12);
        i = (n << 3) + (fine >> 4); /* n*8 + fine/16 */

        p1 = logtab[i];
        p2 = logtab[i + 1];

        return (interpolate((fine / 16), 0, 15, p1, p2) >> o);

    }

    function interpolate(p, p1, p2, v1, v2)
    {
        var dp, dv, di;

        if (p1 == p2)
            return v1;

        dv = (v2 - v1);
        dp = (p2 - p1);
        di = (p - p1);

        return Math.floor(v1 + (Math.floor(di * dv) / dp));
    }

    function getOldPeriod(note, c2spd)
    {
        if (c2spd == 0)
            return 4242;

        var nn = Math.floor(note);
        var o = Math.floor(note * one12);
        var n = nn - o*12;
        //var n = nn % 12;
        //var o = Math.floor(note / 12);

        //return ((8363 * mytab[n]) >> o) / c2spd;

        //test interpolering.
        var d = note - nn;
        var dl = ((8363 * mytab[n]) >> o);

        if(d == 0)
            return dl / c2spd;

        n++;
        if(n >= mytab.length){
            n = 0;
            o++;
        }
        var dh = ((8363 * mytab[n]) >> o);

        var res = (dl * (1-d) + (dh * d));

        //test slut, verkar smutt
        return res / c2spd;

    }

    function toWord(lsb, msb) {
        return ((((msb&0xFF) << 8) & 0xFF00) | (lsb & 0xFF)) & 0xFFFF;
    }

    function toSignedWord(b)
    {
        return (b&32767) - (((b&32768)==32768) ? 32768 : 0);
    }

    function initInstruments(){
        setProgress("Init instruments",0,song.Instruments.length-1);
        debug('loading instruments');
        var t=0, c= 0,ct=0,mn=9999999,mx=0;
        $.each(song.Instruments, function () {
            if(this.Samples.length){
                extractRawData(this);
                var r = this.Samples[0].SampleRate;
                t += r;
                mn = mn < r ? mn : r;
                mx = mx > r ? mx : r;
                c++;
            }
            ct++;
            setProgress("Init instruments",ct,song.Instruments.length-1);
        });
        instrumentInfo = {
            countWithSamples: c,
            count: ct,
            minRate: mn,
            maxRate: mx,
            avgRate: t / c
        };
        debug(instrumentInfo);
        var rate = 22050 > mx ? 22050 : mx;
        if(rate <= 44100){
            debug('SampleRate aim ', rate);
            self.setDownsample(Math.floor(context.sampleRate/rate));
        }

    }

    function extractRawData(instrument) {
        if (!instrument.Samples.length) {
            instrument.WaveData = [];
            return;
        }

        //TODO: hantera alla samples, det måste hanteras när man spelar upp oxo, men det är ett framtida problem..
        var sample = instrument.Samples[0];
        var s = instrument.Samples[0].SampleBytes, ix = 0;

        if (!instrument.Samples[0].SampleBytes) {
            return;
        }
        var r = sample.SampleRate;

        if (sample.Flags & sampleFlags.SF_16BITS) {
            var data = new Float32Array(Math.floor(sample.Length / 2));

            for (var i = 0; i < s.length; i += 2) {
                n = toWord(s[i], s[i+1]);
                n = toSignedWord(n);
                data[ix++] = (n / 65535.0);
            }
        } else { //8-bit
            var data = new Float32Array(sample.Length);//buffer.getChannelData(0);

            for (var i = 0; i < sample.Length; i++) {
                var v = s[i];
                data[ix++] = v < 128 ? v / 128.0 : ((v-128.0)/128.0)-1.0;
            }
        }
        instrument.WaveData = data;
    }


    //GUI.. bryt ut till egen fil/class.

    function initLayout(){
        $(playerSelector).empty();
        setProgress("Creating patterns",0,song.Patterns.length-1);
        for(var i=0;i<song.Patterns.length;i++)
        {
            setProgress("Creating patterns",i,song.Patterns.length-1);
            //debug('Creating pattern ' + (i+1) + ' of ' + song.Patterns.length);
            createPattern(i);
        }

        /*
        $.each(song.Instruments, function () {
            insts.append($("<option value=\"" + (index++) + "\">" + this.InsName + "</option>"));
        });
        */
    }

    function scrollPatternTo(index) {
        setTimeout(function(){
            playerElement.scrollTop = 12*index;
        },0);
    }

    function createPattern(p){
        var pat = song.Patterns[p],
            tracks = pat.Tracks,
            rows = pat.RowsCount,
            w = tracks.length < 11 ? '' : ' style="width:' + (tracks.length * 90 + 20) + 'px"';

        pat.html = "#pattern" + p;
        var data = '<div class="track" id="pattern'+p+'"' + w + '>';
        for(var n=0;n<rows; n++)
        {
            data += '<div class="row">';
            data += "<div class=\"num" + ((n%4 == 0) ? " hl" : "") + "\">" + fillZero(n.toString(16)) + "</div>";
            for (var r = 0; r < tracks.length; r++)
            {
                var cells = tracks[r].Cells;
                var nonote = cells[n][NoteData.Period] == 96;
                data += "<div class=\"note c" + r + "\">";
                data += "<div class=\"tone\">" + (nonote ? '<div class="nonote"></div>' : toNote(cells[n][NoteData.Note], cells[n][NoteData.Octave])) + "</div>";
                data += "<div class=\"instrument\">" + formatInstrument(cells[n][NoteData.Instrument]) + "</div>";
                //data += "<div class=\"vol\">" + formatVolume(cells[n][NoteData.Period]) + "</div>";
                data += "<div class=\"fx\">" + formatFx(cells[n][NoteData.Effect]) + "</div>";
                data += "<div class=\"fxp\">" + formatFxP(cells[n][NoteData.EffectData]) + "</div>";
                data += "</div>";
            }
            data += '</div>';
        }
        data += '</div>';
        $(playerSelector).append(data);
        pat.element = $(pat.html)[0];
    }

    function fillZero(v){
        var l = v.length;
        if(v.length === 2)
            return v;
        if(v.length === 1)
            return '0' + v;
        return '00';
    }

    var scale=["C-","C#","D-","D#","E-","F-","F#","G-","G#","A-","A#","B-"];
    function toNote(note, octave)
    {
        if (!note && note != 0)
            return "---";

        var n = scale[note % 12];
        return n + octave;
    }

    function formatInstrument(i){
        if(i==0)
            return "--";
        return fillZero(i.toString(16));
    }

    function formatVolume(i){
        if(i==0)
            return "--";
        return fillZero(i.toString(16));
    }

    function formatFx(i){
        /*
        if(!i || i==0)
            return "--";
        return fillZero(i.toString(16));
        */
        if(!i || i==0)
            return "-";

        if(i < 10)
            return i;
        switch (i){
            case effetcs.PTEFFECTA: return "A";
            case effetcs.PTEFFECTB: return "B";
            case effetcs.PTEFFECTC: return "C";
            case effetcs.PTEFFECTD: return "D";
            case effetcs.PTEFFECTE: return "E";
            case effetcs.PTEFFECTF: return "F";
            case effetcs.S3MEFFECTA: return "A";
            case effetcs.S3MEFFECTD: return "D";
            case effetcs.S3MEFFECTE: return "E";
            case effetcs.S3MEFFECTF: return "F";
            case effetcs.S3MEFFECTI: return "I";
            case effetcs.S3MEFFECTQ: return "Q";
            case effetcs.S3MEFFECTT: return "T";
            case effetcs.XMEFFECTA: return "A";
            case effetcs.XMEFFECTG: return "G";
            case effetcs.XMEFFECTH: return "H";
            case effetcs.XMEFFECTP: return "P";
        }

        return "-";
        //return fillZero(i.toString(16));
    }

    function formatFxP(i){
        if(!i || i==0)
            i = "--";

        return fillZero(i.toString(16));
    }

    var lastPattern=null;
    function showPattern(p) {
        if(visiblePattern == p)
            return;

        if(lastPattern)
            lastPattern.style.display = "none";

        //$("#pattern" + visiblePattern).hide();
        visiblePattern = p;

        song.Patterns[p].element.style.display = "block";
        lastPattern = song.Patterns[p].element;
        //$(song.Patterns[p].html).show();
    }

}

Tracker.prototype.load = function(url, onloaded){
    var self = this;
    self.onLoading();
    $.getJSON(url, function(data){
        self.onLoaded(data);
        if(onloaded)
            onloaded(data);
    });
};



function plotAudio(data, width, height, strokeStyle) {
    width = width || 1280;
    height = height || 200;
    var $canvas = $('<canvas>').attr({ width: width, height: height }).css({ cursor: 'pointer' }),
        ctx = $canvas[0].getContext('2d'),
        dw = width / data.length, x = 0, h2 = height / 2;
    ctx.strokeStyle = strokeStyle||'#FFF';
    ctx.beginPath();
    ctx.moveTo(x, h2);
    for (var i = 0; i < data.length; ++i) {
        ctx.lineTo(x, h2 + h2 * data[i]);
        x += dw;
    }
    ctx.stroke();

    return $canvas;
}

function extractFlags(f) {
    var s = "";
    if ((f & sampleFlags.SF_16BITS) != 0) {
        s += "|16Bit";
    }
    if ((f & sampleFlags.SF_BIDI) != 0) {
        s += "|BIDI";
    }
    if ((f & sampleFlags.SF_BIG_ENDIAN) != 0) {
        s += "|Big_Endian";
    }
    if ((f & sampleFlags.SF_DELTA) != 0) {
        s += "|Delta";
    }
    if ((f & sampleFlags.SF_NOLOOP) != 0) {
        s += "|NoLoop";
    }
    if ((f & sampleFlags.SF_OWNPAN) != 0) {
        s += "|Ownpan";
    }
    if ((f & sampleFlags.SF_REVERSE) != 0) {
        s += "|Reverse";
    }
    if ((f & sampleFlags.SF_SIGNED) != 0) {
        s += "|Signed";
    }
    if (s.length > 0)
        return s.substring(1);

    return "";
}

(function() {
    var lastTime = 0;
    var vendors = ['webkit', 'moz','o'];
    for(var x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
        window.requestAnimationFrame = window[vendors[x]+'RequestAnimationFrame'];
        window.cancelAnimationFrame =
            window[vendors[x]+'CancelAnimationFrame'] || window[vendors[x]+'CancelRequestAnimationFrame'];
    }

    if (!window.requestAnimationFrame)
        window.requestAnimationFrame = function(callback, element) {
            var currTime = new Date().getTime();
            var timeToCall = Math.max(0, 16 - (currTime - lastTime));
            var id = window.setTimeout(function() { callback(currTime + timeToCall); },
                timeToCall);
            lastTime = currTime + timeToCall;
            return id;
        };

    if (!window.cancelAnimationFrame)
        window.cancelAnimationFrame = function(id) {
            clearTimeout(id);
        };
}());

//constants, tables etc
var NoteData = { Effect:0, EffectData:1, Instrument:2, Note:3, Octave:4, Period:5},
    LOGFAC = 2 * 16,
    modFlags = { UF_XMPERIODS: 1, UF_LINEAR: 2 },
    sampleFlags = { SF_16BITS:1, SF_SIGNED:2, SF_DELTA:4, SF_BIG_ENDIAN:8, SF_NOLOOP:16, SF_BIDI:32, SF_OWNPAN:64, SF_REVERSE:128 },
    mytab = [(1712 * 16), (1616 * 16), (1524 * 16), (1440 * 16), (1356 * 16), (1280 * 16), (1208 * 16), (1140 * 16), (1076 * 16), (1016 * 16), (960 * 16), (907 * 16) ],
    lintab = [16726, 16741, 16756, 16771, 16786, 16801, 16816, 16832, 16847, 16862, 16877, 16892, 16908, 16923, 16938, 16953, 16969, 16984, 16999, 17015, 17030, 17046, 17061, 17076, 17092, 17107, 17123, 17138, 17154, 17169, 17185, 17200, 17216, 17231, 17247, 17262, 17278, 17293, 17309, 17325, 17340, 17356, 17372, 17387, 17403, 17419, 17435, 17450, 17466, 17482, 17498, 17513, 17529, 17545, 17561, 17577, 17593, 17608, 17624, 17640, 17656, 17672, 17688, 17704, 17720, 17736, 17752, 17768, 17784, 17800, 17816, 17832, 17848, 17865, 17881, 17897, 17913, 17929, 17945, 17962, 17978, 17994, 18010, 18027, 18043, 18059, 18075, 18092, 18108, 18124, 18141, 18157, 18174, 18190, 18206, 18223, 18239, 18256, 18272, 18289, 18305, 18322, 18338, 18355, 18372, 18388, 18405, 18421, 18438, 18455, 18471, 18488, 18505, 18521, 18538, 18555, 18572, 18588, 18605, 18622, 18639, 18656, 18672, 18689, 18706, 18723, 18740, 18757, 18774, 18791, 18808, 18825, 18842, 18859, 18876, 18893, 18910, 18927, 18944, 18961, 18978, 18995, 19013, 19030, 19047, 19064, 19081, 19099, 19116, 19133, 19150, 19168, 19185, 19202, 19220, 19237, 19254, 19272, 19289, 19306, 19324, 19341, 19359, 19376, 19394, 19411, 19429, 19446, 19464, 19482, 19499, 19517, 19534, 19552, 19570, 19587, 19605, 19623, 19640, 19658, 19676, 19694, 19711, 19729, 19747, 19765, 19783, 19801, 19819, 19836, 19854, 19872, 19890, 19908, 19926, 19944, 19962, 19980, 19998, 20016, 20034, 20052, 20071, 20089, 20107, 20125, 20143, 20161, 20179, 20198, 20216, 20234, 20252, 20271, 20289, 20307, 20326, 20344, 20362, 20381, 20399, 20418, 20436, 20455, 20473, 20492, 20510, 20529, 20547, 20566, 20584, 20603, 20621, 20640, 20659, 20677, 20696, 20715, 20733, 20752, 20771, 20790, 20808, 20827, 20846, 20865, 20884, 20902, 20921, 20940, 20959, 20978, 20997, 21016, 21035, 21054, 21073, 21092, 21111, 21130, 21149, 21168, 21187, 21206, 21226, 21245, 21264, 21283, 21302, 21322, 21341, 21360, 21379, 21399, 21418, 21437, 21457, 21476, 21496, 21515, 21534, 21554,
        21573, 21593, 21612, 21632, 21651, 21671, 21690, 21710, 21730, 21749, 21769, 21789, 21808, 21828, 21848, 21867, 21887, 21907, 21927, 21946, 21966, 21986, 22006, 22026, 22046, 22066, 22086, 22105, 22125, 22145, 22165, 22185, 22205, 22226, 22246, 22266, 22286, 22306, 22326, 22346, 22366, 22387, 22407, 22427, 22447, 22468, 22488, 22508, 22528, 22549, 22569, 22590, 22610, 22630, 22651, 22671, 22692, 22712, 22733, 22753, 22774, 22794, 22815, 22836, 22856, 22877, 22897, 22918, 22939, 22960, 22980, 23001, 23022, 23043, 23063, 23084, 23105, 23126, 23147, 23168, 23189, 23210, 23230, 23251, 23272, 23293, 23315, 23336, 23357, 23378, 23399, 23420, 23441, 23462, 23483, 23505, 23526, 23547, 23568, 23590, 23611, 23632, 23654, 23675, 23696, 23718, 23739, 23761, 23782, 23804, 23825, 23847, 23868, 23890, 23911, 23933, 23954, 23976, 23998, 24019, 24041, 24063, 24084, 24106, 24128, 24150, 24172, 24193, 24215, 24237, 24259, 24281, 24303, 24325, 24347, 24369, 24391, 24413, 24435, 24457, 24479, 24501, 24523, 24545, 24567, 24590, 24612, 24634, 24656, 24679, 24701, 24723, 24746, 24768, 24790, 24813, 24835, 24857, 24880, 24902, 24925, 24947, 24970, 24992, 25015, 25038, 25060, 25083, 25105, 25128, 25151, 25174, 25196, 25219, 25242, 25265, 25287, 25310, 25333, 25356, 25379, 25402, 25425, 25448, 25471, 25494, 25517, 25540, 25563, 25586, 25609, 25632, 25655, 25678, 25702, 25725, 25748, 25771, 25795, 25818, 25841, 25864, 25888, 25911, 25935, 25958, 25981, 26005, 26028, 26052, 26075, 26099, 26123, 26146, 26170, 26193, 26217, 26241, 26264, 26288, 26312, 26336, 26359, 26383, 26407, 26431, 26455, 26479, 26502, 26526, 26550, 26574, 26598, 26622, 26646, 26670, 26695, 26719, 26743, 26767, 26791, 26815, 26839, 26864, 26888, 26912, 26937, 26961, 26985, 27010, 27034, 27058, 27083, 27107, 27132, 27156, 27181, 27205, 27230, 27254, 27279, 27304, 27328, 27353, 27378, 27402, 27427, 27452, 27477, 27502, 27526, 27551, 27576, 27601, 27626, 27651, 27676, 27701, 27726, 27751, 27776, 27801,
        27826, 27851, 27876, 27902, 27927, 27952, 27977, 28003, 28028, 28053, 28078, 28104, 28129, 28155, 28180, 28205, 28231, 28256, 28282, 28307, 28333, 28359, 28384, 28410, 28435, 28461, 28487, 28513, 28538, 28564, 28590, 28616, 28642, 28667, 28693, 28719, 28745, 28771, 28797, 28823, 28849, 28875, 28901, 28927, 28953, 28980, 29006, 29032, 29058, 29084, 29111, 29137, 29163, 29190, 29216, 29242, 29269, 29295, 29322, 29348, 29375, 29401, 29428, 29454, 29481, 29507, 29534, 29561, 29587, 29614, 29641, 29668, 29694, 29721, 29748, 29775, 29802, 29829, 29856, 29883, 29910, 29937, 29964, 29991, 30018, 30045, 30072, 30099, 30126, 30154, 30181, 30208, 30235, 30263, 30290, 30317, 30345, 30372, 30400, 30427, 30454, 30482, 30509, 30537, 30565, 30592, 30620, 30647, 30675, 30703, 30731, 30758, 30786, 30814, 30842, 30870, 30897, 30925, 30953, 30981, 31009, 31037, 31065, 31093, 31121, 31149, 31178, 31206, 31234, 31262, 31290, 31319, 31347, 31375, 31403, 31432, 31460, 31489, 31517, 31546, 31574, 31602, 31631, 31660, 31688, 31717, 31745, 31774, 31803, 31832, 31860, 31889, 31918, 31947, 31975, 32004, 32033, 32062, 32091, 32120, 32149, 32178, 32207, 32236, 32265, 32295, 32324, 32353, 32382, 32411, 32441, 32470, 32499, 32529, 32558, 32587, 32617, 32646, 32676, 32705, 32735, 32764, 32794, 32823, 32853, 32883, 32912, 32942, 32972, 33002, 33031, 33061, 33091, 33121, 33151, 33181, 33211, 33241, 33271, 33301, 33331, 33361, 33391, 33421],
    logtab = [
        (LOGFAC * 907), (LOGFAC * 900), (LOGFAC * 894),
        (LOGFAC * 887), (LOGFAC * 881), (LOGFAC * 875),
        (LOGFAC * 868), (LOGFAC * 862), (LOGFAC * 856),
        (LOGFAC * 850), (LOGFAC * 844), (LOGFAC * 838),
        (LOGFAC * 832), (LOGFAC * 826), (LOGFAC * 820),
        (LOGFAC * 814), (LOGFAC * 808), (LOGFAC * 802),
        (LOGFAC * 796), (LOGFAC * 791), (LOGFAC * 785),
        (LOGFAC * 779), (LOGFAC * 774), (LOGFAC * 768),
        (LOGFAC * 762), (LOGFAC * 757), (LOGFAC * 752),
        (LOGFAC * 746), (LOGFAC * 741), (LOGFAC * 736),
        (LOGFAC * 730), (LOGFAC * 725), (LOGFAC * 720),
        (LOGFAC * 715), (LOGFAC * 709), (LOGFAC * 704),
        (LOGFAC * 699), (LOGFAC * 694), (LOGFAC * 689),
        (LOGFAC * 684), (LOGFAC * 678), (LOGFAC * 675),
        (LOGFAC * 670), (LOGFAC * 665), (LOGFAC * 660),
        (LOGFAC * 655), (LOGFAC * 651), (LOGFAC * 646),
        (LOGFAC * 640), (LOGFAC * 636), (LOGFAC * 632),
        (LOGFAC * 628), (LOGFAC * 623), (LOGFAC * 619),
        (LOGFAC * 614), (LOGFAC * 610), (LOGFAC * 604),
        (LOGFAC * 601), (LOGFAC * 597), (LOGFAC * 592),
        (LOGFAC * 588), (LOGFAC * 584), (LOGFAC * 580),
        (LOGFAC * 575), (LOGFAC * 570), (LOGFAC * 567),
        (LOGFAC * 563), (LOGFAC * 559), (LOGFAC * 555),
        (LOGFAC * 551), (LOGFAC * 547), (LOGFAC * 543),
        (LOGFAC * 538), (LOGFAC * 535), (LOGFAC * 532),
        (LOGFAC * 528), (LOGFAC * 524), (LOGFAC * 520),
        (LOGFAC * 516), (LOGFAC * 513), (LOGFAC * 508),
        (LOGFAC * 505), (LOGFAC * 502), (LOGFAC * 498),
        (LOGFAC * 494), (LOGFAC * 491), (LOGFAC * 487),
        (LOGFAC * 484), (LOGFAC * 480), (LOGFAC * 477),
        (LOGFAC * 474), (LOGFAC * 470), (LOGFAC * 467),
        (LOGFAC * 463), (LOGFAC * 460), (LOGFAC * 457),
        (LOGFAC * 453), (LOGFAC * 450), (LOGFAC * 447),
        (LOGFAC * 443), (LOGFAC * 440), (LOGFAC * 437),
        (LOGFAC * 434), (LOGFAC * 431)];
var VibratoTable = [
    0, 24, 49, 74, 97, 120, 141, 161,
        180, 197, 212, 224, 235, 244, 250, 253,
        255, 253, 250, 244, 235, 224, 212, 197,
        180, 161, 141, 120, 97, 74, 49, 24 ];
for(var i=0; i<64; i++) {VibratoTable[i] = Math.sin(i/32.0*Math.PI);}
var effetcs = {
       PTEFFECT0: 0,
       PTEFFECT1: 1,
       PTEFFECT2: 2,
       PTEFFECT3: 3,
       PTEFFECT4: 4,
       PTEFFECT5: 5,
       PTEFFECT6: 6,
       PTEFFECT7: 7,
       PTEFFECT8: 8,
       PTEFFECT9: 9,
       PTEFFECTA: 10,
       PTEFFECTB: 11,
       PTEFFECTC: 12,
       PTEFFECTD: 13,
       PTEFFECTE: 14,
       PTEFFECTF: 15,
       S3MEFFECTA: 16,
       S3MEFFECTD: 17,
       S3MEFFECTE: 18,
       S3MEFFECTF: 19,
       S3MEFFECTI: 20,
       S3MEFFECTQ: 21,
       S3MEFFECTT: 22,
       XMEFFECTA: 23,
       XMEFFECTG: 24,
       XMEFFECTH: 25,
       XMEFFECTP: 26
};

var notes = [];
notes[81] = 36+12+12;
notes[50] = 37+12+12;
notes[87] = 38+12+12;
notes[51] = 39+12+12;
notes[69] = 40+12+12;
notes[82] = 41+12+12;
notes[53] = 42+12+12;
notes[84] = 43+12+12;
notes[54] = 44+12+12;
notes[89] = 45+12+12;
notes[55] = 46+12+12;
notes[85] = 47+12+12;
notes[73] = 48+12+12;
notes[57] = 49+12+12;
notes[79] = 50+12+12;
notes[48] = 51+12+12;
notes[80] = 52+12+12;

notes[90] = 36+12;
notes[83] = 37+12;
notes[88] = 38+12;
notes[68] = 39+12;
notes[67] = 40+12;
notes[86] = 41+12;
notes[71] = 42+12;
notes[66] = 43+12;
notes[72] = 44+12;
notes[78] = 45+12;
notes[74] = 46+12;
notes[77] = 47+12;
notes[188] =notes[81];
notes[190] =notes[87];
notes[76] = notes[50];
notes[192] =notes[51];

/* ,=Q .=W L=2 Ö=3 */