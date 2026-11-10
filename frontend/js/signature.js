// Pen Signature (credential request form). The student draws their signature with the mouse, a finger or a stylus.
// The picture stays TRANSPARENT where nothing is drawn, so the server's background check passes (same API as before):
// window.SignaturePad.isEmpty() / toDataURL() / clear(). The server checks the PNG again.
(function () {
  const canvas = document.getElementById("signatureCanvas");
  if (!canvas) return;
  const clearBtn = document.getElementById("signatureClear");
  const hint = document.getElementById("signatureHint");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const MIN_INK_PIXELS = 300;                       // a few real strokes, not a dot
  const HINT = "Sign inside the box with your mouse, finger or stylus.";
  let drawing = false, last = null, hasInk = false, inkChecked = true;

  function style() {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "#111111"; ctx.lineWidth = 3;
  }
  style();
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (W / Math.max(1, rect.width)), y: (event.clientY - rect.top) * (H / Math.max(1, rect.height)) };
  }
  function say(text, bad) { if (hint) { hint.textContent = text; hint.style.color = bad ? "#b3261e" : ""; } }

  canvas.addEventListener("pointerdown", event => {
    if (event.button > 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing = true; last = point(event);
    canvas.removeAttribute("aria-invalid");
    if (canvas._notice) { canvas._notice.remove(); canvas._notice = null; }
    ctx.beginPath(); ctx.arc(last.x, last.y, 1.5, 0, Math.PI * 2); ctx.fillStyle = "#111111"; ctx.fill();   // a tap leaves a dot
    hasInk = true; inkChecked = false;
    say(HINT);
  });
  canvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    event.preventDefault();
    const p = point(event), mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  const stop = () => { drawing = false; last = null; };
  ["pointerup", "pointercancel", "pointerleave"].forEach(name => canvas.addEventListener(name, stop));
  canvas.addEventListener("touchmove", event => { if (drawing) event.preventDefault(); }, { passive: false });   // the page must not scroll while signing

  function inkPixels() {
    const d = ctx.getImageData(0, 0, W, H).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n;
  }
  function clear() {
    ctx.clearRect(0, 0, W, H);                      // back to fully transparent
    style(); hasInk = false; inkChecked = true; drawing = false; last = null;
    canvas.removeAttribute("aria-invalid");
    if (canvas._notice) { canvas._notice.remove(); canvas._notice = null; }
    say(HINT);
  }
  if (clearBtn) clearBtn.addEventListener("click", clear);
  clear();

  window.SignaturePad = {
    // Empty = nothing drawn, or too little to be a signature.
    isEmpty: () => {
      if (!hasInk) return true;
      if (!inkChecked) { if (inkPixels() < MIN_INK_PIXELS) { say("Your signature is too small. Please sign again.", true); return true; } inkChecked = true; }
      return false;
    },
    toDataURL: () => canvas.toDataURL("image/png"),
    clear
  };
})();