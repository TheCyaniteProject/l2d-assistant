const { contextBridge, ipcRenderer } = require('electron');

let isMuted = false;

contextBridge.exposeInMainWorld('api', {

    minimize: () => ipcRenderer.send('minimize'),
    close: () => ipcRenderer.send('close'),
    openDevTools: () => ipcRenderer.send('open-devtools'),

    // Settings menu
    sendApiKey: (key) => ipcRenderer.send('apikey', key),
    sendTtsToggle: (isEnabled) => ipcRenderer.send('ttstoggle', isEnabled),
    sendTtsVoice: (voice) => ipcRenderer.send('ttsvoice', voice),
    sendLlmModel: (model) => ipcRenderer.send('llmmodel', model),
    sendHotword: (phrase) => ipcRenderer.send('hotword', phrase),
    sendInstructions: (instructions) => ipcRenderer.send('instructions', instructions),
    sendPinTop: (isOnTop) => ipcRenderer.send('pintop', isOnTop),

    sendIsMuted: (_isMuted) => isMuted = _isMuted,

    receiveSpeechMessage: (callback) => {
        ipcRenderer.on('speech-message', (event, value, message, type) => {
            console.log("Preload " + type);
            callback(value, message, type);
        });
    }
});

ipcRenderer.on('play-audio', (event, bufferData) => {
    // Convert the received Node.js Buffer to a Uint8Array
    const uint8Array = new Uint8Array(bufferData);

    // Create a Blob specifying the MIME type for MPEG audio
    const blob = new Blob([uint8Array], { type: 'audio/mpeg' });

    // Create an object URL for the Blob
    const url = URL.createObjectURL(blob);

    // Create an audio element and play the URL
    const audio = new Audio(url);
    audio.play().catch(err => console.error('Error playing audio:', err));
});

(async () => { // Not gunna lie, I had GPT do the threshold stuff for me. I know, this is a dev sin, but my tiny brain couldn't figure it out.

    /*
    This is probably finnnneeee to push into production. No one has background noise anyways right?
    I'll just come back later and fix this when I implement my setting menu.
    Promise :)
    */
    const VOLUME_THRESHOLD = 0.03;

    // These probably need to be adjusted. Eh, I'll do it later.
    const SILENCE_TIME_REQUIRED = 2000; // Amount of silence in milliseconds required before we stop recording
    const MINIMUM_TIME = 3000; // Minimum audio length in milliseconds before we will send the audio to whisper, to prevent false-positives and to reduce API usage.

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const dataArray = new Float32Array(analyser.fftSize);

    const options = { mimeType: 'audio/webm;codecs=opus' };
    let mediaRecorder = null;
    let recordedChunks = [];
    let recording = false;
    let silenceStartTime = null;
    let recordingStartTime = 0;

    function startRecording() {
        console.log("Auto starting recording...");
        recordedChunks = [];

        mediaRecorder = new MediaRecorder(stream, options);
        recordingStartTime = Date.now();
        mediaRecorder.ondataavailable = event => {
            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            const recordingDuration = Date.now() - recordingStartTime;
            console.log("Recording duration (ms):", recordingDuration);

            if (recordingDuration >= MINIMUM_TIME) {
                question.style.display = 'none';
                answer.style.display = 'block';
                answer.textContent = '...';
                const blob = new Blob(recordedChunks, { type: options.mimeType });
                const arrayBuffer = await blob.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
                ipcRenderer.send('recorded-audio', { buffer, mimeType: options.mimeType });
            } else {
                answer.style.display = 'none';
                console.log(`Recording discarded: duration less than ${MINIMUM_TIME}ms.`); // Okay fr, what is it with AI code and the extreme amount of debug logs? What you're seeing are the ones I didn't remove.
            }
        };

        mediaRecorder.start();
        recording = true;
        silenceStartTime = null;
        console.log("Recording started.");
    }

    function stopRecording() {
        if (mediaRecorder && recording) {
            console.log("Auto stopping recording...");
            mediaRecorder.stop();
            recording = false;
        }
    }

    function getRMS() {
        analyser.getFloatTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sumSquares += dataArray[i] ** 2;
        }
        return Math.sqrt(sumSquares / dataArray.length);
    }

    function monitorVolume() {
        const rms = getRMS();

        if (!isMuted) {
            if (!recording && rms > VOLUME_THRESHOLD) {
                answer.style.display = 'block';
                answer.textContent = 'Listening...';
                startRecording();
            }
    
            if (recording) {
                if (rms < VOLUME_THRESHOLD) {
                    if (!silenceStartTime) {
                        silenceStartTime = performance.now();
                    } else {
                        const silenceDuration = performance.now() - silenceStartTime;
                        if (silenceDuration > SILENCE_TIME_REQUIRED) {
                            stopRecording();
                            silenceStartTime = null;
                        }
                    }
                } else {
                    silenceStartTime = null;
                }
            }
        }

        requestAnimationFrame(monitorVolume);
    }

    monitorVolume(); // Did I mention this threshold code was generated by ChatGPT in one-shot? Honestly it's kind of impressive.
})();