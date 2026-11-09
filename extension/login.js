// Shown in a pane instead of a sign-in page (Google, Meta, Claude) that refuses to load in a frame.
// Asks the viewer (same extension origin) to open a real login window for this pane.
const requestLogin = () => window.parent.postMessage({ type: 'aiviewer-login' }, location.origin);
const signIn = new URLSearchParams(location.search).has('signin');
document.getElementById('redirected').hidden = signIn;
document.getElementById('signin').hidden = !signIn;
document.getElementById('open').addEventListener('click', requestLogin);
if (!signIn) requestLogin();
