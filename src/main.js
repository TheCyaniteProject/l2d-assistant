const { app, BrowserWindow, ipcMain, session, browser } = require('electron');
const path = require('node:path');
const fs = require("fs");
const os = require("os");
const OpenAI = require("openai");
const { stringify } = require('node:querystring');
const jsdom = require('jsdom');
const windowStateKeeper = require('electron-window-state');

/*
 Initialize the OpenAI client – If you're reading this on GitHub and see an apiKey here then I seriously fucked up.
 If you're wondering why it's here in the first place; First of all, you're not. Because I would -never- (probably) push this to github without removing it.
 ...And also I still need to make my settings menu where you would enter your own key. I pushed that to the "do later" pile.

 -- Future Kiee here; Don't worry bro, I got you b(>ᴗ•)
*/
let openai = undefined;
let ASSISTANT_MODEL = "gpt-4o-mini"; // Or use the better "o3-mini" or any other chat-based model, but 4o-mini is the cheapest.
let INSTRUCTIONS = "You are a helpful assistant. Give simple to-the-point answers only."; // Later this will be customizable. Probably. -- Oh hey I actually did it!
const VOICE_MODEL_MODEL = "gpt-4o-mini-tts"; // TODO honestly should I even make this customizable?
let VOICE_MODEL_VOICE = "alloy";
let VOICE_MODEL_ENABLED = true;
let ACTIVATION_HOTWORD = "Assistant";
let PIN_TOP = false;

const ASSISTANT_TOOLS = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Get current temperature for provided coordinates in celsius.",
            parameters: {
                type: "object",
                properties: {
                    latitude: { type: "number" },
                    longitude: { type: "number" }
                },
                required: ["latitude", "longitude"],
                additionalProperties: false
            },
            strict: true
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the internet for surface information and links",
            parameters: {
                type: "object",
                properties: {
                    quary: {
                        type: "string",
                        description: "The text used for the search",
                    },
                },
                required: ["quary"],
                additionalProperties: false
            },
            strict: true
        }
    },
    { // This is for testing parameter-less |functions
        type: "function",
        function: {
            name: "get_status",
            description: "Get the current status of the network.",
            parameters: {
                type: "object",
                properties: {
                },
                additionalProperties: false
            },
            strict: true
        }
    }
];

// Tools

async function get_weather(latitude, longitude) {
    //mainWindow.webContents.send('speech-message', true, `Getting weather data...`);
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`);
    const data = await response.json();
    return data.current.temperature_2m;
}

// My friend Shy helped so much with this part! He works with Javascrip a lot, including some mods and scripts for BitBurner
// You should check him out! https://github.com/shyguy1412
async function web_search(query) { 

    mainWindow.webContents.send('speech-message', true, `Searching the web for ${query}...`);
    const headers = {
        'User-Agent':
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
        "Content-Type": "application/x-www-form-urlencoded"
    };

    return await fetch(`https://www.startpage.com/sp/search`, {
        headers,
        method: "POST",
        body: `query=${query}`
    }).then((response) => response.text()).then((response) => {
        const dom = new jsdom.JSDOM(response);

        // dom.window.document.body.outerHTML
        const headlines = [...dom.window.document.querySelectorAll('.w-gl .result')].map(r => ({
            headline: r.querySelector('.wgl-title').textContent,
            description: r.querySelector('.description').textContent,
            link: r.querySelector('.result-link').href
        }));
        return headlines;
            
    })
    .catch((error) => {
        console.error('Error fetching Google search results:', error);
    });
}

async function get_status() {
    return "OK.";
}

async function textToSpeech(textInput) {
    //speech_file_path = path.join(__dirname, 'speech.mp3')
    try {
        const speechFile = path.join(__dirname, 'speech.mp3');

        const voice = await openai.audio.speech.create({
            model: VOICE_MODEL_MODEL,
            voice: VOICE_MODEL_VOICE,
            input: textInput,
        });

        const buffer = Buffer.from(await voice.arrayBuffer());
        //await fs.promises.writeFile(speechFile, buffer);
        mainWindow.webContents.send('play-audio', buffer);
        console.log("Voice Done.");
    } catch (error) {
        console.error("Error during text-to-speech:", error);
        throw error;
    }
    
}

async function speechToText(window, audioFilePath) {
    /*
     Dear god why is it so hard to implement STT in Electron on Windows???
     OpenAI, you are amazing and I love you for making this so easy. I just wish I haden't spent 3 days trying to get webkitSpeechRecognition working
     Google, you're an asshole. No clarification needed.
    */
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioFilePath),
            model: "whisper-1",
        });
        console.log("Transcription:", transcription.text);

        if (transcription.text.toLowerCase().includes(ACTIVATION_HOTWORD.toLowerCase())) {
            let message = transcription.text.toString();

            const hotwordRegex = new RegExp(`\\b${ACTIVATION_HOTWORD}[,\\.]?\\s*`, "i");
            message = message.replace(hotwordRegex, "");

            message = message.charAt(0).toUpperCase() + message.slice(1);

            console.log(message);

            mainWindow.webContents.send('speech-message', true, message, "question");
            promptAssistant(message.trim());
        }
        else {
            mainWindow.webContents.send('speech-message', true, "", "answer");
        }
    } catch (error) {
        console.error("Error during speech-to-text:", error);
        throw error;
    }
}

async function promptAssistant(prompt) {

    const messages = [
        {
            role: "system",
            content: INSTRUCTIONS
        },
        {
            role: "user",
            content: prompt
        }
    ];

    let completion = await openai.chat.completions.create({
        messages: messages,
        model: ASSISTANT_MODEL,
        tools: ASSISTANT_TOOLS,
        store: true,
    });

    // Testing

    console.log(completion.choices[0].message.tool_calls); // testing

    if (completion.choices[0].message.tool_calls !== null && completion.choices[0].message.tool_calls !== undefined) {

        messages.push(completion.choices[0].message); // append model's function call message

        for (var i = 0; i < completion.choices[0].message.tool_calls.length; i++) {

            const toolCall = completion.choices[0].message.tool_calls[i];

            const args = JSON.parse(toolCall.function.arguments);

            switch (toolCall.function.name) {
                case "get_weather":

                    const result1 = await get_weather(args.latitude, args.longitude);
                    console.log(result.toString())
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: result1.toString()
                    });
                    break;
                case "get_status": 

                    const result2 = await get_status();

                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: result2.toString()
                    });
                    break;
                case "web_search":
                    const result3 = await web_search(args.quary);

                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: result3.toString()
                    });
                    break;
                }
            }

        const completion2 = await openai.chat.completions.create({ // now with function response
            messages: messages,
            model: ASSISTANT_MODEL,
            tools: ASSISTANT_TOOLS,
            store: true,
        });

        handleAssistantResponse(completion2)
    }
    else {
        handleAssistantResponse(completion)
    }
}

async function handleAssistantResponse(completion) {
    const response = completion.choices[0].message.content;
    console.log("Response: " + response);
    if (VOICE_MODEL_ENABLED) {
        await textToSpeech(response);
    }
    mainWindow.webContents.send('speech-message', false, response);
}

let mainWindow;

const createWindow = () => {
    let mainWindowState = windowStateKeeper();

    mainWindow = new BrowserWindow({
        x: mainWindowState.x,
        y: mainWindowState.y,
        width: 400,
        height: 800,
        resizable: false,
        transparent: true,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindowState.manage(mainWindow);

    mainWindow.loadFile('index.html');

    ipcMain.on('minimize', () => {
        mainWindow.minimize();
    });
    ipcMain.on('close', () => {
        mainWindow.close();
    });
    ipcMain.on('open-devtools', () => {
        mainWindow.webContents.openDevTools();
    });

    // Settings
    ipcMain.on('apikey', (event, key) => {
        console.log("Received APIKey");
        openai = new OpenAI({ apiKey: key });
    });
    ipcMain.on('ttstoggle', (event, key) => {
        console.log("Received TTS isEnabled: ", key);
        VOICE_MODEL_ENABLED = key;
    });
    ipcMain.on('ttsvoice', (event, key) => {
        console.log("Received TTS Voice: ", key);
        VOICE_MODEL_VOICE = key;
    });
    ipcMain.on('hotword', (event, key) => {
        console.log("Received Activation Word: ", key);
        ACTIVATION_HOTWORD = key;
    });
    ipcMain.on('llmmodel', (event, key) => {
        console.log("Received LLM Model: ", key);
        ASSISTANT_MODEL = key;
    });
    ipcMain.on('instructions', (event, key) => {
        console.log("Received LLM Instructions: ", key);
        INSTRUCTIONS = key;
    });
    ipcMain.on('pintop', (event, key) => {
        console.log("Received mainWindow alwaysOnTop: ", key);
        PIN_TOP = key;
        mainWindow.setAlwaysOnTop(key);
    });
}

app.whenReady().then(() => {
    createWindow();

    // Wait.. why is this here twic- you know what, I don't care. Don't fix something that's already working.
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit(); // Why does Mac gotta be so weird? And who's Darwin?
});

app.on('ready', () => {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') {
            // Approve microphone access (and also camera because it's tied to 'media')
            return callback(true);
        }
        callback(false);
    });
});

ipcMain.on('recorded-audio', (event, { buffer, mimeType }) => {
    /*
     ChatGPT added this 'ext' variable here while I was troubleshooting an issue. Why? I have no idea. I don't question our AI overlord.
     What's that? You're wondering why I used ChatGPT in parts of my code? Aside from me being lazy, I'm using 3 different OpenAI APIs for this app. Did you -really- expect me not to cheat a little?
     To answer your next question: No, the code I pasted didn't fix my issue, but I left it anyways :)
    */
    const ext = mimeType.includes("webm") ? ".webm" : ".wav";
    const tempFilePath = path.join(os.tmpdir(), "desktopassist"+ext);

    fs.writeFile(tempFilePath, buffer, (err) => {
        if (err) {
            console.error("Error writing audio file:", err);
            return;
        }

        console.log("Saved recorded audio to", tempFilePath);

        speechToText(mainWindow, tempFilePath)
            .then(() => {
                console.log("Speech processed successfully");

                // Optionally, delete the temporary file after processing.
                // fs.unlink(tempFilePath, err => { if(err) console.error("Could not delete temp file", err); });
            })
            .catch(err => console.error("Error processing speech:", err));
    });
});