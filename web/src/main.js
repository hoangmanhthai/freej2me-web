import { LibMedia } from "../libmedia/libmedia.js";
import { LibMidi, createUnlockingAudioContext } from "../libmidi/libmidi.js";
import { codeMap, KeyRepeatManager } from "./key.js";
import { EventQueue } from "./eventqueue.js";
import { initKbdListeners, setKbdHandler, kbdWidth, kbdHeight } from "./screenKbd.js";

// we need to import natives here, don't use System.loadLibrary
// since CheerpJ fails to load them in firefox and we can't set breakpoints
import canvasFontNatives from "../libjs/libcanvasfont.js";
import canvasGraphicsNatives from "../libjs/libcanvasgraphics.js";
import gles2Natives from "../libjs/libgles2.js";
import jsReferenceNatives from "../libjs/libjsreference.js";
import mediaBridgeNatives from "../libjs/libmediabridge.js";
import midiBridgeNatives from "../libjs/libmidibridge.js";

const evtQueue = new EventQueue();
const sp = new URLSearchParams(location.search);

const cheerpjWebRoot = '/app'+location.pathname.replace(/\/[^/]*$/,'');

let isMobile = sp.get('mobile');

let display = null;
let screenCtx = null;

let fractionScale = sp.get('fractionScale') || (localStorage && localStorage.getItem("pl.zb3.freej2me.fractionScale") === "true");
let scaleSet = false;

const keyRepeatManager = new KeyRepeatManager();

window.evtQueue = evtQueue;
const debugNet = !!(sp.get('netDebug') || sp.get('netdebug'));

function autoscale() {
    if (!scaleSet) return;

    let screenWidth = window.innerWidth;
    let screenHeight = window.innerHeight;

    if (isMobile) {
        document.getElementById('left-keys').style.display = '';
        document.getElementById('right-keys').style.display = '';

        if (screenWidth > screenHeight) {
            document.body.classList.add('kbd-landscape');
            document.body.classList.remove('kbd-portrait');
            screenWidth = screenWidth - 2*kbdWidth;
        } else {
            document.body.classList.add('kbd-portrait');
            document.body.classList.remove('kbd-landscape');
            screenHeight = screenHeight - kbdHeight;
        }
    }

    let scale = Math.min(
        screenWidth/screenCtx.canvas.width,
        screenHeight/screenCtx.canvas.height
    );

    if (!fractionScale) {
        scale = scale|0;
    }

    display.style.zoom = scale;
}

function setListeners() {
    let mouseDown = false;
    let noMouse = false;

    setKbdHandler((isDown, key) => {
        const symbol = key.startsWith('Digit') ? key.substring(5) : '\x00';
        keyRepeatManager.post(isDown, key, {symbol, ctrlKey: false, shiftKey: false});
    });

    function handleKeyEvent(e) {
        const isDown = e.type === 'keydown';

        if (codeMap[e.code]) {
            keyRepeatManager.post(isDown, e.code, {
                symbol: e.key.length == 1 ? e.key.charCodeAt(0) : '\x00',
                ctrlKey: e.ctrlKey,
                shiftKey: e.shiftKey
            })
        }
        e.preventDefault();
    }

    display.addEventListener('keydown', handleKeyEvent);
    display.addEventListener('keyup', handleKeyEvent);

    keyRepeatManager.register((kind, key, args) => {
        if (kind === 'click') {
            if (key === 'Maximize') {
                fractionScale = !fractionScale;
                localStorage && localStorage.setItem("pl.zb3.freej2me.fractionScale", fractionScale);
                autoscale();
            }
        } else if (codeMap[key]) {
            // console.log('queuin event');
            evtQueue.queueEvent({
                kind: kind === 'up' ? 'keyup' : 'keydown',
                args: [codeMap[key], args.symbol, args.ctrlKey, args.shiftKey]
            });
        }
    });

    display.addEventListener('mousedown', async e => {
        display.focus();
        if (noMouse) return;

        evtQueue.queueEvent({
            kind: 'pointerpressed',
            x: e.offsetX / display.currentCSSZoom | 0,
            y: e.offsetY / display.currentCSSZoom | 0,
        });

        mouseDown = true;

        e.preventDefault();
    });

    display.addEventListener('mousemove', async e => {
        if (noMouse) return;
        if (!mouseDown) return;

        evtQueue.queueEvent({
            kind: 'pointerdragged',
            x: e.offsetX / display.currentCSSZoom | 0,
            y: e.offsetY / display.currentCSSZoom | 0,
        });

        e.preventDefault();
    });

    document.addEventListener('mouseup', async e => {
        if (noMouse) return;
        if (!mouseDown) return;

        mouseDown = false;

        evtQueue.queueEvent({
            kind: 'pointerreleased',
            x: (e.pageX - display.offsetLeft) / display.currentCSSZoom | 0,
            y: (e.pageY - display.offsetTop) / display.currentCSSZoom | 0,
        });

        e.preventDefault();
    });


    display.addEventListener('touchstart', async e => {
        display.focus();
        noMouse = true;

        evtQueue.queueEvent({
            kind: 'pointerpressed',
            x: (e.changedTouches[0].pageX - display.offsetLeft) / display.currentCSSZoom | 0,
            y: (e.changedTouches[0].pageY - display.offsetTop) / display.currentCSSZoom | 0,
        });

        e.preventDefault();
    }, {passive: false});

    display.addEventListener('touchmove', async e => {
        noMouse = true;

        evtQueue.queueEvent({
            kind: 'pointerdragged',
            x: (e.changedTouches[0].pageX - display.offsetLeft) / display.currentCSSZoom | 0,
            y: (e.changedTouches[0].pageY - display.offsetTop) / display.currentCSSZoom | 0,
        });

        e.preventDefault();
    }, {passive: false});

    display.addEventListener('touchend', async e => {
        noMouse = true;

        evtQueue.queueEvent({
            kind: 'pointerreleased',
            x: (e.changedTouches[0].pageX - display.offsetLeft) / display.currentCSSZoom | 0,
            y: (e.changedTouches[0].pageY - display.offsetTop) / display.currentCSSZoom | 0,
        });

        e.preventDefault();
    });

    document.addEventListener('mousedown', e => {
        setTimeout(() => display.focus(), 20);
        ;
    });

    display.addEventListener('blur', e => {
        // it doesn't work without any timeout
        setTimeout(() => display.focus(), 10);
        ;
    });

    window.addEventListener('resize', autoscale);

    initKbdListeners();
}

function setFaviconFromBuffer(arrayBuffer) {
    const blob = new Blob([arrayBuffer], { type: 'image/png' });

    const reader = new FileReader();
    reader.onload = function() {
        const dataURL = reader.result;

        let link = document.querySelector("link[rel*='icon']");
        if (!link) {
            link = document.createElement('link');
            link.setAttribute('rel', 'icon');
            document.head.appendChild(link);
        }
        link.setAttribute('href', dataURL);
    };
    reader.readAsDataURL(blob);
}

async function ensureAppInstalled(lib, appId) {
    const appFile = await cjFileBlob(appId + "/app.jar");

    if (!appFile) {
        const launcherUtil = await lib.pl.zb3.freej2me.launcher.LauncherUtil;

        await launcherUtil.installFromBundle(cheerpjWebRoot + "/apps/", appId);
    }
}

async function init() {
    document.getElementById("loading").textContent = "Loading CheerpJ...";

    display = document.getElementById('display');
    screenCtx = display.getContext('2d', { desynchronized: true });
    screenCtx.imageSmoothingEnabled = false;

    setListeners();

    window.libmidi = new LibMidi(createUnlockingAudioContext());
    await window.libmidi.init();
    window.libmidi.midiPlayer.addEventListener('end-of-media', e => {
        window.evtQueue.queueEvent({kind: 'player-eom', player: e.target});
    })
    window.libmedia = new LibMedia();

    await cheerpjInit({
        enableDebug: false,
        natives: {
            ...canvasFontNatives,
            ...canvasGraphicsNatives,
            ...gles2Natives,
            ...jsReferenceNatives,
            ...mediaBridgeNatives,
            ...midiBridgeNatives,
            async Java_pl_zb3_freej2me_bridge_shell_Shell_setTitle(lib, title) {
                document.title = title;
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_setIcon(lib, iconBytes) {
                if (iconBytes) {
                    setFaviconFromBuffer(iconBytes.buffer);
                }
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_getScreenCtx(lib) {
                return screenCtx;
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_setCanvasSize(lib, width, height) {
                if (!scaleSet) {
                    document.getElementById('loading').hidden = true;
                    display.style.display = '';
                    scaleSet = true;
                    display.focus();
                }
                screenCtx.canvas.width = width;
                screenCtx.canvas.height = height;
                autoscale();
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_waitForAndDispatchEvents(lib, listener) {
                const KeyEvent = await lib.pl.zb3.freej2me.bridge.shell.KeyEvent;
                const PointerEvent = await lib.pl.zb3.freej2me.bridge.shell.PointerEvent;

                const evt = await evtQueue.waitForEvent();
                if (evt.kind == 'keydown') {
                    await listener.keyPressed(await new KeyEvent(...evt.args));
                } else if (evt.kind == 'keyup') {
                    await listener.keyReleased(await new KeyEvent(...evt.args));
                } else if (evt.kind == 'pointerpressed') {
                    await listener.pointerPressed(await new PointerEvent(evt.x, evt.y));
                } else if (evt.kind == 'pointerdragged') {
                    await listener.pointerDragged(await new PointerEvent(evt.x, evt.y));
                } else if (evt.kind == 'pointerreleased') {
                    await listener.pointerReleased(await new PointerEvent(evt.x, evt.y));
                } else if (evt.kind == 'player-eom') {
                    await listener.playerEOM(evt.player);
                } else if (evt.kind == 'player-video-frame') {
                    await listener.playerVideoFrame(evt.player);
                }
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_restart(lib) {
                location.reload();
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_exit(lib) {
                location.href = './';
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_sthop(lib) {
                debugger;
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_say(lib, sth) {
                console.log('[say]', sth);
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_sayObject(lib, label, obj) {
                debugger;
                console.log('[sayobject]', label, obj);
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_netSocketOpen(lib, url) {
                if (debugNet) console.log('[net] open', url);
                const ws = new WebSocket(url);
                ws.binaryType = 'arraybuffer';
                const handle = {
                    ws,
                    rx: [],
                    rxLen: 0,
                    closed: false,
                    waiters: [],
                    txLen: 0,
                    lastLog: 0,
                };

                const wake = () => {
                    if (handle.waiters.length) {
                        const w = handle.waiters;
                        handle.waiters = [];
                        for (const r of w) r();
                    }
                };

                ws.addEventListener('message', e => {
                    if (e.data instanceof ArrayBuffer) {
                        const u8 = new Uint8Array(e.data);
                        if (u8.byteLength) {
                            handle.rx.push(u8);
                            handle.rxLen += u8.byteLength;
                        }
                    }
                    if (debugNet) {
                        const now = performance.now();
                        if (now - handle.lastLog > 5000) {
                            handle.lastLog = now;
                            console.log('[net] rx', handle.rxLen, 'tx', handle.txLen);
                        }
                    }
                    wake();
                });
                ws.addEventListener('close', () => {
                    handle.closed = true;
                    if (debugNet) console.log('[net] close');
                    wake();
                });
                ws.addEventListener('error', () => {
                    handle.closed = true;
                    if (debugNet) console.log('[net] error');
                    wake();
                });

                await new Promise((resolve, reject) => {
                    ws.addEventListener('open', resolve, { once: true });
                    ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true });
                });

                return handle;
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_netSocketRead(lib, handle, buffer, offset, length) {
                if (length <= 0) return 0;

                while (!handle.closed && handle.rxLen === 0) {
                    await new Promise(r => handle.waiters.push(r));
                }

                if (handle.rxLen === 0 && handle.closed) {
                    return -1;
                }

                const out = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
                let written = 0;

                while (written < length && handle.rx.length) {
                    const chunk = handle.rx[0];
                    const take = Math.min(chunk.byteLength, length - written);
                    out.set(chunk.subarray(0, take), written);
                    written += take;
                    if (take === chunk.byteLength) {
                        handle.rx.shift();
                    } else {
                        handle.rx[0] = chunk.subarray(take);
                    }
                    handle.rxLen -= take;
                }

                return written;
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_netSocketWrite(lib, handle, buffer, offset, length) {
                if (length <= 0) return;
                if (handle.closed) throw new Error('ws closed');
                const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
                handle.ws.send(u8);
                handle.txLen += length;
                if (debugNet) {
                    const now = performance.now();
                    if (now - handle.lastLog > 5000) {
                        handle.lastLog = now;
                        console.log('[net] rx', handle.rxLen, 'tx', handle.txLen);
                    }
                }
            },
            async Java_pl_zb3_freej2me_bridge_shell_Shell_netSocketClose(lib, handle) {
                try {
                    handle.closed = true;
                    handle.ws.close();
                } catch (e) {
                }
            }
        }
    });

    document.getElementById("loading").textContent = "Loading...";

    let jarUrl = cheerpjWebRoot + "/freej2me-web.jar";
    if (sp.get('nocache')) {
        jarUrl += (jarUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
    }
    const lib = await cheerpjRunLibrary(jarUrl);

    const FreeJ2ME = await lib.org.recompile.freej2me.FreeJ2ME;

    const socketProxy = sp.get('socketProxy') || sp.get('socketproxy');
    const netDebug = sp.get('netDebug') || sp.get('netdebug');
    if (socketProxy || netDebug) {
        const System = await lib.java.lang.System;
        if (socketProxy) {
            await System.setProperty('freej2me.socketProxy', socketProxy);
            console.log('[net] using socketProxy', socketProxy);
        }
        if (netDebug) {
            await System.setProperty('freej2me.netDebug', 'true');
        }
    }

    let args;

    if (sp.get('app')) {
        const app = sp.get('app');
        await ensureAppInstalled(lib, app);

        args = ['app', sp.get('app')];
    } else {
        args = ['jar', cheerpjWebRoot+"/jar/" + (sp.get('jar') || "game.jar")];
    }

    FreeJ2ME.main(args).catch(e => {
        e.printStackTrace();
        document.getElementById('loading').textContent = 'Crash :(';
    });


}

init();
