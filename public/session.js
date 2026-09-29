'use strict';
// Runs before the upstream scripts. Credentials stay in this page's memory.
window.AntarTalkCall = (() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticket = fragment.get('ticket');
    const parentOrigin = fragment.get('parentOrigin');
    history.replaceState(null, '', '/call');
    let sessionId;
    let terminal = false;
    let expiryTimer;
    // AbortSignal.timeout is absent in older iOS WebViews supported by Expo 54.
    const exchangeController = new AbortController();
    const exchangeTimer = ticket ? setTimeout(() => exchangeController.abort(), 15_000) : undefined;
    const ready = ticket ? fetch('/v1/exchange', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }), signal: exchangeController.signal,
    }).then(async response => {
        const result = await response.json();
        if (!response.ok) return { error: result.message || 'Unable to join this session.' };
        sessionId = result.sessionId;
        expiryTimer = setTimeout(() => finish('ended', 'This session has ended.'), Math.max(0, Date.parse(result.expiresAt) - Date.now()));
        return result;
    }).catch(() => ({ error: 'Unable to connect. Return to AntarTalk and try joining again.' }))
        .finally(() => clearTimeout(exchangeTimer)) :
        Promise.resolve({ error: 'Open this session from your appointment in AntarTalk.' });

    function emit(type, message) {
        const event = { source: 'antartalk-video', version: 1, type, sessionId, ...(message ? { message } : {}) };
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(event));
        if (window.parent !== window && parentOrigin) window.parent.postMessage(event, parentOrigin);
    }
    function notice(message) {
        const show = () => {
            let panel = document.getElementById('antartalk-notice');
            if (!panel) {
                panel = document.createElement('section');
                panel.id = 'antartalk-notice';
                panel.setAttribute('role', 'alert');
                document.body.appendChild(panel);
            }
            panel.replaceChildren();
            const title = document.createElement('h1');
            title.textContent = 'AntarTalk video session';
            const detail = document.createElement('p');
            detail.textContent = message;
            const help = document.createElement('p');
            help.textContent = 'You can close this screen and return to your appointment.';
            panel.append(title, detail, help);
            for (const element of document.body.children) {
                if (element !== panel) element.setAttribute('inert', '');
            }
        };
        if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
    }
    function finish(type = 'left', message = 'You have left the call.') {
        if (terminal) return;
        terminal = true;
        exchangeController.abort();
        clearTimeout(exchangeTimer);
        clearTimeout(expiryTimer);
        window.dispatchEvent(new Event('antartalk-stop'));
        emit(type, message);
        notice(message);
    }
    window.addEventListener('pagehide', () => finish());
    window.addEventListener('message', event => {
        if (event.source === window.parent && event.origin === parentOrigin && event.data?.source === 'antartalk-host' && event.data.type === 'leave') finish();
    });
    function requestPlayback() {
        if (terminal || document.getElementById('antartalk-play')) return;
        const button = document.createElement('button');
        button.id = 'antartalk-play';
        button.textContent = 'Tap to enable call audio and video';
        button.onclick = async () => {
            const results = await Promise.allSettled([...document.querySelectorAll('video')].map(video => video.play()));
            if (results.every(result => result.status === 'fulfilled')) button.remove();
        };
        document.body.appendChild(button);
    }
    return { ready, emit, finish, requestPlayback, get terminal() { return terminal; } };
})();
