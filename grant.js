// One-time camera grant page. Chrome side panels often cannot show the camera
// permission prompt, so the side panel opens this ordinary tab instead: the
// prompt works here, and the granted permission persists for the whole
// extension origin — after this, the side panel can use the camera silently.
const statusEl = document.getElementById('status');
const hintBox = document.getElementById('hintBox');
const retryBtn = document.getElementById('retry');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}
function setHint(html) {
  hintBox.style.display = html ? 'block' : 'none';
  hintBox.innerHTML = html || '';
}

async function closeSelf() {
  chrome.runtime.sendMessage({ hw: true, t: 'closeMe' }).catch(() => {});
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) { await chrome.tabs.remove(tab.id); return; }
  } catch { /* fall through */ }
  window.close();
}

async function attempt() {
  setHint('');
  setStatus('Requesting camera & microphone access…');
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStatus('✅ Camera & microphone enabled — returning to the Handwave panel.', 'ok');
    } catch (err) {
      // no microphone on this machine: camera alone still enables gestures
      if (err.name !== 'NotFoundError' && err.name !== 'OverconstrainedError') throw err;
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      setStatus('✅ Camera enabled. No microphone was found — voice dictation won’t work.', 'ok');
    }
    stream.getTracks().forEach((t) => t.stop());
    chrome.runtime.sendMessage({ hw: true, t: 'camGranted' }).catch(() => {});
    setTimeout(closeSelf, 1400);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      const perm = await navigator.permissions.query({ name: 'camera' }).catch(() => null);
      if (perm?.state === 'denied') {
        setStatus('Camera or microphone access is blocked for this extension.', 'error');
        setHint(
          'To unblock it:<br>' +
          '1. Click the <b>camera icon</b> (or the lock/tune icon) in the address bar of this tab.<br>' +
          '2. Choose <b>“Always allow”</b> for the camera and microphone.<br>' +
          '3. Press <b>Try again</b> below.<br><br>' +
          'Alternatively: chrome://settings/content/camera and …/microphone → remove this extension from the “Not allowed” list.'
        );
      } else {
        setStatus('Chrome is asking for permission — choose “Allow” in the prompt.', 'error');
        setHint('If no prompt appeared, click the camera icon in the address bar, allow access, then press <b>Try again</b>.');
      }
    } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      setStatus('No camera was detected on this computer.', 'error');
    } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
      setStatus('The camera is in use by another app — close it and press Try again.', 'error');
    } else {
      setStatus(`Camera error: ${err.name || err}`, 'error');
    }
  }
}
retryBtn.addEventListener('click', attempt);
attempt();
