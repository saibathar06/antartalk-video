// Served ONLY by tests/preview.js. Never included in the production image.
'use strict';
navigator.mediaDevices.getUserMedia = async (constraints) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    let frame = 0;
    const paint = () => {
        context.fillStyle = '#243c58';
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = '#ffffff';
        context.font = '28px sans-serif';
        context.fillText('Synthetic AntarTalk test video', 70, 155);
        context.fillText(`Frame ${frame++}`, 250, 210);
    };
    paint();
    const timer = setInterval(paint, 100);
    const stream = canvas.captureStream(10);
    const audio = new AudioContext();
    const destination = audio.createMediaStreamDestination();
    if (constraints.audio) stream.addTrack(destination.stream.getAudioTracks()[0]);
    if (!constraints.video) stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
    const cleanup = () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); audio.close(); };
    window.addEventListener('antartalk-stop', cleanup, { once: true });
    window.addEventListener('pagehide', cleanup, { once: true });
    return stream;
};
