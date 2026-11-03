// Shown in a pane instead of a sign-in page (Google, Meta, xAI) that refuses to load in a frame.
// Asks the viewer (same extension origin) to open a real login window for this pane.
const requestLogin = () => window.parent.postMessage({ type: 'aiviewer-login' }, location.origin);
document.getElementById('again').addEventListener('click', requestLogin);
requestLogin();
