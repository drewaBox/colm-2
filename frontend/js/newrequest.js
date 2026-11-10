// Student only: the document catalog and the request form.
// Documents, prices, release methods and requirements all come from the database (api/documents.php).
(function () {
  const MAX_COPIES = 5;
  const docGrid = document.getElementById("docGrid");
  const requestFormPanel = document.getElementById("requestFormPanel");
  const requestsHistoryCard = document.getElementById("requestsHistoryCard");
  const form = document.getElementById("documentRequestForm");
  const documentRows = document.getElementById("requestDocumentRows");
  const requirementsList = document.getElementById("requestRequirementsList");
  const releaseSelect = document.getElementById("requestReleaseMethod");
  const paymentSelect = document.getElementById("requestPaymentMethod");

  // Opened from the landing page "Request a Document" form: the wizard shows as an overlay and leaving returns to index.html.
  let landingFlow = false;
  try { landingFlow = new URLSearchParams(location.search).get("landing") === "1" || !!(JSON.parse(sessionStorage.getItem("colmRequestDraft") || "null") || {}).document; } catch (error) { /* storage may be off */ }
  if (landingFlow) { document.documentElement.classList.add("landing-flow"); document.body.classList.add("landing-flow"); }
  const endLandingFlow = () => { document.documentElement.classList.remove("landing-flow"); document.body.classList.remove("landing-flow"); };
  // Inside the landing page overlay (an iframe) ask the landing page to close it; opened on its own, go back to index.html.
  // With a tracking number, the landing page opens its Track page with that number already typed in the search box.
  const backToLanding = (tracking) => {
    if (window.parent !== window) window.parent.postMessage({ colmClose: true, track: tracking || "" }, window.location.origin);
    else window.location.href = "index.html" + (tracking ? "?track=" + encodeURIComponent(tracking) : "");
  };
  const message = document.getElementById("requestFormMessage");
  const successPanel = document.getElementById("requestSuccess");
  const successQrStatus = document.getElementById("requestSuccessQrStatus");
  const successQrImage = document.getElementById("requestSuccessQrImage");
  const successQrDownload = document.getElementById("requestSuccessQrDownload");
  const submitButton = document.getElementById("submitRequestBtn");
  const steps = [...document.querySelectorAll("[data-request-step]")];
  const stepIndicators = [...document.querySelectorAll("[data-step-indicator]")];
  const stepper = document.querySelector(".request-stepper");
  const PURPOSE_HINT = "e.g. Scholarship application, employment, transfer";

  let catalog = [];            // documents from the database
  let studentAccount = null;
  let activeStep = 1;
  let latestRequest = null;

  async function prepareSuccessQr(requestId, tracking) {
    successQrImage.replaceChildren();
    successQrImage.hidden = true;
    successQrDownload.hidden = true;
    successQrStatus.classList.remove("is-error");
    successQrStatus.textContent = "Preparing your request QR code…";
    try {
      if (typeof QrCode === "undefined") throw new Error("QR code generator is unavailable.");
      const data = await Api.get("qr.php", { request_id: requestId });
      const canvas = document.createElement("canvas");
      canvas.className = "qr-canvas";
      canvas.setAttribute("aria-label", "Request QR code for " + data.tracking_no);
      QrCode.draw(canvas, data.qr_text);
      successQrImage.append(canvas);
      successQrImage.hidden = false;
      successQrDownload.href = canvas.toDataURL("image/png");
      successQrDownload.download = `COLM-${tracking}-QR.png`;
      successQrDownload.hidden = false;
      successQrStatus.textContent = "Save this QR image, then upload it on the Upload QR page to check your request.";
    } catch (error) {
      successQrStatus.classList.add("is-error");
      successQrStatus.textContent = "Could not prepare your QR code. You can still track your request using the number in your email.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "request-back-btn";
      retry.textContent = "Try QR again";
      retry.addEventListener("click", () => prepareSuccessQr(requestId, tracking));
      successQrImage.replaceChildren(retry);
      successQrImage.hidden = false;
    }
  }
  let messageTimer = null;
  let verifiedStudentInformationFingerprint = "";
  let studentVerificationCheckedFingerprint = "";
  let studentVerificationAttempt = 0;
  const chosenFiles = new Map();         // "rowId:requirementId" -> File
  // "rowId:requirementId" -> { state: "checking" | "accepted" | "received" | "declined", checkId, title, message, filename }
  const checks = new Map();
  let checksRunning = 0;                 // how many files are being verified right now
  const reviewedRows = new Set();        // rows where the student ticked "I have reviewed these requirements"
  const FORM_KEY = "colmRequestForm";    // auto-restore: what was typed in the form survives a page refresh
  let formDraftReady = false;            // false while the form is being built or restored, so an empty form never overwrites the saved one

  // ---------- Catalog ----------
  function processingText(doc) {
    if (doc.processing_max_days === 0) return "Same business day";
    return doc.processing_min_days === doc.processing_max_days
      ? `${doc.processing_min_days} working days` : `${doc.processing_min_days}-${doc.processing_max_days} working days`;
  }

  function dateKey(date) {
    const part = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
  }

  function addProcessingDays(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
    for (let remaining = Math.max(0, days); remaining > 0;) {
      date.setDate(date.getDate() + 1);
      if (date.getDay() !== 0 && date.getDay() !== 6) remaining--;
    }
    return date;
  }

  function releaseDateFor(doc) {
    const start = addProcessingDays(doc.processing_min_days), end = addProcessingDays(doc.processing_max_days);
    const label = start.getTime() === end.getTime()
      ? Portal.formatDate(dateKey(start)) : `${Portal.formatDate(dateKey(start))} – ${Portal.formatDate(dateKey(end))}`;
    return { start, end, label };
  }

  function renderCatalog() {
    docGrid.innerHTML = catalog.length ? catalog.map(doc => `
      <div class="doc-item">
        <div class="doc-card">
          <h3>${escapeHtml(doc.name)}</h3>
          <span class="doc-price">${doc.price}</span>
          <p class="doc-desc">${escapeHtml(doc.description || "")}</p>
          <button class="doc-request-btn" type="button" data-document-id="${doc.id}" ${doc.pending_request ? "disabled" : ""}>
            ${doc.pending_request ? "Request Limit Reached" : "Select Document"}
          </button>
          ${doc.pending_request ? `<p class="request-date-note">You already have 10 requests in progress for this document (latest: ${escapeHtml(doc.pending_tracking_no)}). One must be completed, rejected or cancelled before you can request it again.</p>` : ""}
        </div>
        <div class="doc-card-meta">
          <p><strong>Processing Days:</strong> ${escapeHtml(processingText(doc))}</p>
          <p class="meta-label"><strong>Requirements:</strong></p>
          ${doc.credential_form_required ? '<p class="meta-check"><span class="material-symbol">check_circle</span> Completed credential request form</p>' : ""}
          ${doc.student_verification_form_required ? '<p class="meta-check"><span class="material-symbol">check_circle</span> Student Verification form</p>' : ""}
          ${doc.requirements.map(req => `<p class="meta-check"><span class="material-symbol">check_circle</span> ${escapeHtml(req.name)}</p>`).join("")}
          <p class="meta-label"><strong>Available Released Method:</strong></p>
          ${doc.release_methods.map(method => `<p class="meta-check"><span class="material-symbol">check_circle</span> ${escapeHtml(method)}</p>`).join("")}
        </div>
      </div>`).join("") : '<p class="requests-empty">No documents are available right now.</p>';
    document.dispatchEvent(new CustomEvent("table:rendered"));
  }

  docGrid.addEventListener("click", event => {
    const button = event.target.closest("[data-document-id]");
    if (button) startRequest(button.dataset.documentId);
  });

  // ---------- Messages and steps ----------
  function showMessage(text) {
    message.setAttribute("role", "alert");
    message.textContent = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(clearMessage, 8000);
  }
  // One notice at a time: the old ones are removed first, and the text is shown only once (as a pop-up, not also inside the form).
  function showValidationNotification(text) {
    clearMessage();
    document.querySelectorAll("#toastBox .toast-error").forEach(t => t.remove());
    Portal.toast(text, "error", "Missing information");
  }
  function clearMessage() {
    clearTimeout(messageTimer);
    message.setAttribute("role", "status");
    message.textContent = "";
  }
  function clearInvalidField(field) {
    if (!field) return;
    field.removeAttribute("aria-invalid");
    if (field._notice) { field._notice.remove(); field._notice = null; }
    field.classList.remove("is-missing");
    const uploadBox = field.closest(".upload-box")
      || (field.nextElementSibling?.classList.contains("upload-box") ? field.nextElementSibling : null);
    const dropzone = uploadBox?.querySelector(".request-requirement-dropzone");
    if (dropzone) dropzone.classList.remove("is-missing");
    const signatureDrop = document.getElementById("signatureDrop");
    if (field.id === "signatureFile" && signatureDrop) signatureDrop.removeAttribute("aria-invalid");
    const reviewOption = field.closest(".request-confirm-option");
    if (reviewOption) reviewOption.classList.remove("is-missing");
  }
  function showFieldValidation(problem) {
    showStep(problem.step);
    clearValidationMarks();
    showValidationNotification(problem.message);
    const field = problem.field;
    if (!field) return;
    field.setAttribute("aria-invalid", "true");
    if (field.id === "signatureDrop") field.tabIndex = -1;
    if (field.classList.contains("request-requirement-confirm")) field.closest(".request-confirm-option")?.classList.add("is-missing");
    const uploadBox = field.closest(".upload-box")
      || (field.nextElementSibling?.classList.contains("upload-box") ? field.nextElementSibling : null);
    const dropzone = uploadBox?.querySelector(".request-requirement-dropzone");
    if (dropzone) {
      dropzone.classList.add("is-missing");
      dropzone.tabIndex = -1;
    }
    requestAnimationFrame(() => {
      const focusTarget = dropzone || field;
      focusTarget.scrollIntoView({ behavior: "smooth", block: "center" });
      focusTarget.focus({ preventScroll: true });
    });
  }
  function clearValidationMarks() {
    form.querySelectorAll('[aria-invalid="true"]').forEach(field => clearInvalidField(field));
    form.querySelectorAll(".is-missing").forEach(field => field.classList.remove("is-missing"));
    document.getElementById("signatureDrop")?.removeAttribute("aria-invalid");
  }
  function showStep(step) {
    if (step === 2) step = 1;          // Purpose & Format now live in step 1
    const hasRequirementsStep = requiresRequirementsStep(chosenDocuments());
    if (step === 3 && !hasRequirementsStep) step = 4;
    activeStep = step;
    saveFormDraft();
    steps.forEach(section => { section.hidden = Number(section.dataset.requestStep) !== step; });
    updateStepIndicators(step, hasRequirementsStep);
    // On the Success step only the success message and OK remain: hide the title, Cancel button and step icons.
    // Inline display is used so it works even when an older cached style.css is loaded.
    const onSuccess = step === 5;
    requestFormPanel.classList.toggle("is-success", onSuccess);
    [stepper, document.getElementById("cancelRequestForm"), document.querySelector(".request-form-header")].forEach(el => {
      if (!el) return;
      el.hidden = onSuccess;
      el.style.display = onSuccess ? "none" : "";
    });
    updateNextButtons();
    clearMessage();
  }

  function updateStepIndicators(step, hasRequirementsStep) {
    // Visible steps: 1 Document & Purpose, [3 Requirements], 4 Review, 5 Success (step 2 was merged into step 1).
    const visible = stepIndicators.filter(i => { const n = Number(i.dataset.stepIndicator); return n !== 2 && (hasRequirementsStep || n !== 3); });
    stepper.style.setProperty("--request-step-count", String(visible.length));
    const current = step === 2 ? 1 : step;
    stepIndicators.forEach(indicator => {
      const number = Number(indicator.dataset.stepIndicator);
      const position = visible.indexOf(indicator);
      indicator.hidden = position === -1;
      if (position !== -1) indicator.querySelector("span").textContent = String(position + 1);
      indicator.classList.toggle("active", number === current);
      indicator.classList.toggle("complete", number < current);
      indicator.setAttribute("aria-current", number === current ? "step" : "false");
    });
  }

  // ---------- Document rows (step 1) ----------
  function chosenDocuments() {
    return [...documentRows.querySelectorAll(".request-document-row")].flatMap(row => {
      const doc = catalog.find(item => item.id === Number(row.querySelector(".request-document-select").value));
      const quantity = Number(row.querySelector(".request-quantity").value);
      if (!doc || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COPIES) return [];
      const purposeChoice = row.querySelector(".request-purpose").value;
      const purposeOther = row.querySelector(".request-purpose-other").value.trim();
      return [{ ...doc, rowId: row.dataset.rowId, quantity, purposeChoice, purposeOther, purpose: purposeChoice === "Others" ? purposeOther : purposeChoice, lineTotal: doc.price * quantity, release: releaseDateFor(doc) }];
    });
  }

  // "Others" shows the extra text box; any other purpose hides and empties it.
  documentRows.addEventListener("change", event => {
    if (!event.target.matches(".request-purpose")) return;
    const other = event.target.closest(".request-purpose-field").querySelector(".request-purpose-other");
    other.hidden = event.target.value !== "Others";
    if (other.hidden) other.value = "";
    else other.focus();
    updateSummary();
  });

  // Keep this list the same as PURPOSE_CHOICES in backend/release.php (the server checks it again).
  const PURPOSE_CHOICES = ["Employment", "Evaluation", "Board Examination", "Scholarship", "Transfer to Another School", "Further Studies", "Personal Records"];

  function addDocumentRow(documentId = "") {
    const row = document.createElement("div");
    const id = (window.crypto && typeof crypto.randomUUID === "function") ? crypto.randomUUID()
      : "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const fixedDocument = catalog.find(doc => doc.id === Number(documentId) && !doc.pending_request);
    row.className = "request-document-row";
    row.dataset.rowId = id;
    if (fixedDocument) row.dataset.fixedDocument = "true";
    row.innerHTML = `
      <div class="request-field request-document-field">
        <label for="doc-${id}-${fixedDocument ? "display" : "select"}">Requested document</label>
        ${fixedDocument ? `<output class="request-document-fixed" id="doc-${id}-display">${escapeHtml(fixedDocument.name)}</output>` : ""}
        <select class="request-document-select" id="doc-${id}-select" ${fixedDocument ? "hidden" : ""} required>
          <option value="">-- Choose a document --</option>
          ${catalog.filter(doc => fixedDocument ? doc.id === fixedDocument.id : true).map(doc => `<option value="${doc.id}" ${doc.pending_request ? "disabled" : ""}>${escapeHtml(doc.name)}${doc.pending_request ? " — request limit reached" : ""}</option>`).join("")}
        </select>
      </div>
      <div class="request-field request-quantity-field">
        <label for="qty-${id}">Number of copies</label>
        <input class="request-quantity" id="qty-${id}" type="number" min="1" max="${MAX_COPIES}" step="1" value="1" required>
      </div>
      <div class="request-field request-purpose-field">
        <label for="purpose-${id}">Specific purpose of request</label>
        <select class="request-purpose" id="purpose-${id}" required>
          <option value="">-- Choose a purpose --</option>
          ${PURPOSE_CHOICES.map(p => `<option value="${p}">${p}</option>`).join("")}
          <option value="Others">Others</option>
        </select>
        <input class="request-purpose-other request-text-input" id="purposeOther-${id}" type="text" maxlength="255" placeholder="Please specify your purpose" aria-label="Specify the purpose" hidden>
      </div>
      <button class="request-remove-btn" type="button" aria-label="Remove document" ${fixedDocument ? "hidden" : ""}><span class="material-symbol">delete</span></button>`;
    row.querySelector(".request-document-select").value = documentId;
    documentRows.append(row);
    updateSummary();
  }

  function updateSummary() {
    const picked = new Set([...documentRows.querySelectorAll(".request-document-select")].map(s => s.value).filter(Boolean));
    documentRows.querySelectorAll(".request-document-row").forEach(row => {
      const select = row.querySelector(".request-document-select");
      [...select.options].forEach(option => {
        const doc = catalog.find(item => String(item.id) === option.value);
        option.disabled = !!option.value && (!!doc?.pending_request || (option.value !== select.value && picked.has(option.value)));
      });
    });
    const items = chosenDocuments();

    // Release methods that every chosen document offers
    const common = items.length ? items[0].release_methods.filter(m => items.every(i => i.release_methods.includes(m))) : [];
    const current = releaseSelect.value;
    // Document format: Hard copy, Soft copy (PDF) or both. Soft copy needs every chosen document to offer it (the admin sets this in the Catalog).
    const formats = common.includes("Softcopy") && common.includes("Hardcopy") ? ["Hardcopy", "Softcopy", "Both"] : common;
    releaseSelect.innerHTML = formats.length ? formats.map(m => `<option value="${m}">${formatLabel(m)}</option>`).join("") : '<option value="">Choose a document first</option>';
    releaseSelect.disabled = formats.length === 0;
    // The Document Format field is hidden. Hard copy is used when the document offers it, otherwise the first format offered.
    releaseSelect.value = formats.includes(current) ? current : (formats.includes("Hardcopy") ? "Hardcopy" : (formats[0] || ""));
    // Only one format available (e.g. hard copy only): no dropdown, just show it as text.
    const fixedFormat = document.getElementById("requestReleaseMethodFixed");
    const single = formats.length === 1;
    releaseSelect.hidden = single;
    if (fixedFormat) {
      fixedFormat.hidden = !single;
      fixedFormat.textContent = single ? formatLabel(formats[0]) : "";
    }
    const hint = document.getElementById("formatHint");
    if (hint) hint.textContent = items.length && !common.includes("Softcopy") ? "A soft copy (PDF) is not offered for the selected document(s)." : (items.length ? "A soft copy is released after the payment and the registrar's processing. You can download it from your dashboard." : "");

    const hasRequirementsStep = requiresRequirementsStep(items);
    const uploadRequirements = items.some(item => item.requirements.length > 0);
    document.getElementById("requestUploadFormatsNote").hidden = !uploadRequirements;
    renderRequirements(
      requirementsStepItems(items),
      requirementsList,
      needsCredentialForm(items) || needsStudentVerificationForm(items)
        ? "Complete the required form above. No additional file upload is needed for these documents."
        : "No additional requirements for the selected document(s)."
    );
    updateStepIndicators(activeStep, hasRequirementsStep);
    const purposeNext = document.getElementById("purposeNextButton");
    purposeNext.dataset.nextStep = hasRequirementsStep ? "3" : "4";
    purposeNext.innerHTML = 'Proceed <span aria-hidden="true"></span>';
    document.querySelector('[data-request-step="4"] [data-previous-step]').dataset.previousStep = hasRequirementsStep ? "3" : "2";
    syncCredentialForm(items);
    syncCredentialPurpose(items);
    syncStudentVerificationForm(items);
    refreshStudentVerificationState(items);
    updateNextButtons();
  }

  function isCredentialDocument(item) {
    const name = item.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return name.startsWith("transcriptofrecords") || name === "honorabledismissal" || name.startsWith("form137");
  }

  // The Student Verification form was removed from the process; Certification documents have no Requirements step.
  function isStudentVerificationDocument(item) {
    return false;
  }

  function needsCredentialForm(items) {
    return items.some(isCredentialDocument);
  }

  function needsStudentVerificationForm(items) {
    return items.some(isStudentVerificationDocument);
  }

  function itemNeedsRequirementsStep(item) {
    return isCredentialDocument(item) || isStudentVerificationDocument(item) || item.requirements.length > 0;
  }

  function requiresRequirementsStep(items) {
    return items.some(itemNeedsRequirementsStep);
  }

  function requirementsStepItems(items) {
    return items.filter(itemNeedsRequirementsStep);
  }

  // The account keeps one "First Last" name; split it back so the Request Form can pre-fill Last name and First name.
  // Mobile number: always "+63 " followed by up to 10 digits that start with 9 (e.g. +63 9123456789).
  function formatMobile(raw) {
    let digits = String(raw || "").replace(/\D/g, "");
    if (digits.startsWith("63")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    if (digits && digits[0] !== "9") digits = "";
    return digits ? "+63 " + digits : "";
  }
  (function setupMobileField() {
    const mobile = document.getElementById("credentialMobile");
    if (!mobile) return;
    mobile.addEventListener("input", () => {
      // The "+63 " part cannot be typed over: only the digits after it are taken.
      const typed = mobile.value.startsWith("+63") ? mobile.value.slice(3) : mobile.value;
      mobile.value = formatMobile(typed);
    });
    mobile.addEventListener("focus", () => { if (!mobile.value) mobile.value = "+63 "; });
    mobile.addEventListener("blur", () => { if (mobile.value.trim() === "+63") mobile.value = ""; });
  })();

  function splitAccountName(fullName) {
    const name = String(fullName || "").replace(/\s+/g, " ").trim();
    if (!name) return { first: "", last: "" };
    if (name.includes(",")) {                       // "Santos, Maria"
      const [last, ...rest] = name.split(",");
      return { first: rest.join(" ").trim(), last: last.trim() };
    }
    const words = name.split(" ");
    if (words.length === 1) return { first: words[0], last: "" };
    const particles = new Set(["de", "del", "dela", "delos", "los", "della", "di", "da", "van", "von", "san", "santa", "la", "le"]);
    const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
    let lastStart = words.length - 1;
    if (lastStart > 1 && suffixes.has(words[lastStart].toLowerCase())) lastStart--;
    while (lastStart > 1 && particles.has(words[lastStart - 1].toLowerCase())) lastStart--;
    return { first: words.slice(0, lastStart).join(" "), last: words.slice(lastStart).join(" ") };
  }

  function syncCredentialForm(items = chosenDocuments()) {
    const enabled = needsCredentialForm(items);
    const container = document.getElementById("credentialFormSection");
    container.hidden = !enabled;
    if (enabled && studentAccount) {
      const accountName = splitAccountName(studentAccount.full_name);
      const lastInput = document.getElementById("credentialLastName");
      const firstInput = document.getElementById("credentialFirstName");
      lastInput.value = accountName.last;
      firstInput.value = accountName.first;
      [lastInput, firstInput].forEach(field => {
        field.readOnly = true;
        field.setAttribute("aria-readonly", "true");
        field.classList.add("is-locked");
      });
      document.getElementById("credentialStudentNo").value = studentAccount.student_no || studentAccount.username || "";
      document.getElementById("credentialCourse").value = studentAccount.course || "";
      const mobile = document.getElementById("credentialMobile");
      if (!mobile.value && studentAccount.contact_no) mobile.value = formatMobile(studentAccount.contact_no);
    }
    const requestedDocuments = items.filter(isCredentialDocument).map(item => item.name);
    document.getElementById("credentialRequestedDocuments").innerHTML = requestedDocuments
      .map(name => `<span>${escapeHtml(name)}</span>`).join("");
    syncCredentialGraduationFields();
    updateCredentialPreview();
  }

  function syncStudentVerificationForm(items = chosenDocuments()) {
    const enabled = needsStudentVerificationForm(items);
    document.getElementById("studentVerificationFormSection").hidden = !enabled;
    if (!enabled || !studentAccount) return;
    const values = {
      studentVerificationId: studentAccount.student_no || studentAccount.username || "",
      studentVerificationName: studentAccount.full_name || "",
      studentVerificationCourse: studentAccount.course || "",
      studentVerificationAcademicYear: studentAccount.academic_year || "",
      studentVerificationGradeLevel: studentAccount.year_label || (studentAccount.year_level ? String(studentAccount.year_level) : "")
    };
    // Student ID and Student Name always come from the student's profile and cannot be edited.
    const lockedFields = new Set(["studentVerificationId", "studentVerificationName"]);
    Object.entries(values).forEach(([id, value]) => {
      const field = document.getElementById(id);
      if (lockedFields.has(id)) {
        field.value = value;
        field.readOnly = true;
        field.setAttribute("aria-readonly", "true");
        field.tabIndex = -1;
        field.classList.add("is-locked");
      } else if (!field.value) {
        field.value = value;
      }
    });
  }

  function studentVerificationFormData(items = chosenDocuments()) {
    if (!needsStudentVerificationForm(items)) return null;
    return {
      student_id: document.getElementById("studentVerificationId").value.trim(),
      student_name: document.getElementById("studentVerificationName").value.trim(),
      course_program: document.getElementById("studentVerificationCourse").value.trim(),
      academic_year: document.getElementById("studentVerificationAcademicYear").value.trim(),
      grade_level: document.getElementById("studentVerificationGradeLevel").value.trim()
    };
  }

  function studentVerificationFingerprint(items = chosenDocuments()) {
    return JSON.stringify({
      documents: items.filter(isStudentVerificationDocument).map(item => item.id).sort((a, b) => a - b),
      form: studentVerificationFormData(items)
    });
  }

  function refreshStudentVerificationState(items = chosenDocuments()) {
    const status = document.getElementById("studentVerificationStatus");
    const statusText = document.getElementById("studentVerificationStatusText");
    const button = document.getElementById("requirementsNextButton");
    if (!needsStudentVerificationForm(items)) {
      verifiedStudentInformationFingerprint = "";
      studentVerificationCheckedFingerprint = "";
      statusText.textContent = "";
      status.className = "form-message";
      button.innerHTML = 'Proceed <span aria-hidden="true"></span>';
      return;
    }
    const currentFingerprint = studentVerificationFingerprint(items);
    if ((verifiedStudentInformationFingerprint && verifiedStudentInformationFingerprint !== currentFingerprint)
      || (studentVerificationCheckedFingerprint && studentVerificationCheckedFingerprint !== currentFingerprint)) {
      verifiedStudentInformationFingerprint = "";
      studentVerificationCheckedFingerprint = "";
      status.className = "form-message";
      statusText.textContent = "The information changed since verification. Verify again to refresh the results.";
    }
    button.innerHTML = verifiedStudentInformationFingerprint === currentFingerprint
      ? 'Proceed <span aria-hidden="true"></span>'
      : 'Verify Student Information <span aria-hidden="true"></span>';
  }

  function studentVerificationFormProblem(items = chosenDocuments()) {
    if (!needsStudentVerificationForm(items)) return "";
    const data = studentVerificationFormData(items);
    const profileFields = [
      ["studentVerificationId", data.student_id],
      ["studentVerificationName", data.student_name],
      ["studentVerificationCourse", data.course_program]
    ];
    const missingProfileField = profileFields.find(([, value]) => !value);
    if (missingProfileField) return {
      message: "Your Student ID, student name, and Course/Program must be set in your student profile before requesting a Certificate.",
      field: document.getElementById(missingProfileField[0]), step: 3
    };
    if (!data.academic_year) return {
      message: "Enter the academic year in the Student Verification form.",
      field: document.getElementById("studentVerificationAcademicYear"), step: 3
    };
    const schoolYear = data.academic_year.match(/^(\d{4})-(\d{4})$/);
    if (!schoolYear || Number(schoolYear[2]) !== Number(schoolYear[1]) + 1) {
      return {
        message: "Enter the academic year as consecutive years, for example 2025-2026.",
        field: document.getElementById("studentVerificationAcademicYear"), step: 3
      };
    }
    if (!data.grade_level) return {
      message: "Enter the grade level in the Student Verification form.",
      field: document.getElementById("studentVerificationGradeLevel"), step: 3
    };
    return "";
  }

  function updateCredentialPreview() {
    // No claim-slip preview is shown for credential requests.
  }

  function credentialFormData(items = chosenDocuments()) {
    if (!needsCredentialForm(items)) return null;
    const selectedPurpose = credentialPurposeSelection(items);
    return {
      last_name: document.getElementById("credentialLastName").value.trim(),
      first_name: document.getElementById("credentialFirstName").value.trim(),
      middle_name: document.getElementById("credentialMiddleName").value.trim(),
      address: (window.AddressPicker ? window.AddressPicker.compose() : document.getElementById("credentialAddress").value.trim()),
      barangay: window.AddressPicker ? window.AddressPicker.values().barangay : "",
      city: window.AddressPicker ? window.AddressPicker.values().city : "",
      province: window.AddressPicker ? window.AddressPicker.values().province : "",
      birthdate: document.getElementById("credentialBirthdate").value,
      gender: document.getElementById("credentialGender").value,
      student_no: document.getElementById("credentialStudentNo").value.trim(),
      course: document.getElementById("credentialCourse").value.trim(),
      requested_documents: items.filter(isCredentialDocument).map(item => item.name),
      graduated: studentAccount && studentAccount.status === "alumni" ? "yes" : "no",
      academic_year: document.getElementById("credentialAcademicYear").value.trim(),
      elementary_school: schoolAndYear("Elementary"),
      junior_high_school: schoolAndYear("JuniorHigh"),
      senior_high_school: schoolAndYear("SeniorHigh"),
      mobile: document.getElementById("credentialMobile").value.trim(),
      purpose: selectedPurpose.purpose,
      other_purpose: selectedPurpose.other_purpose,
      signature: [document.getElementById("credentialFirstName").value.trim(),
        document.getElementById("credentialMiddleName").value.trim(),
        document.getElementById("credentialLastName").value.trim()].filter(Boolean).join(" "),
      notes: document.getElementById("credentialNotes").value.trim()
    };
  }

  // The year comes from the student's profile (set by the registrar): alumni = year graduated, enrolled = school year enrolled,
  // undergrad = school year last attended. The student cannot change it here; the server uses the profile value too.
  function syncCredentialGraduationFields() {
    const status = studentAccount ? studentAccount.status : "";
    const label = ({ alumni: "Year graduated", currently_enrolled: "School year enrolled", undergrad: "School year last attended" })[status] || "School year";
    document.getElementById("credentialAcademicYearText").textContent = label;
    document.getElementById("credentialAcademicYear").value = studentAccount && studentAccount.academic_year ? studentAccount.academic_year : "";
  }

  function credentialPurposeSelection(items = chosenDocuments()) {
    const item = items.find(isCredentialDocument);
    if (!item) return { purpose: "", other_purpose: "" };
    return {
      purpose: item.purposeChoice,
      other_purpose: item.purposeChoice === "Others" ? item.purposeOther : ""
    };
  }

  function syncCredentialPurpose(items = chosenDocuments()) {
    const display = document.getElementById("credentialPurposeDisplay");
    const selection = credentialPurposeSelection(items);
    display.textContent = selection.purpose === "Others"
      ? selection.other_purpose
      : selection.purpose || "Choose a purpose in Step 1.";
  }

  // Birthdate: the requester must be at least 18 years old. The notice shows as soon as the date is typed or picked.
  const MIN_AGE = 18;
  function birthdateLatest() {                                   // the newest birthdate that is still 18 or older, as YYYY-MM-DD
    const d = new Date(); d.setFullYear(d.getFullYear() - MIN_AGE);
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function birthdateProblem(value) {
    const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value || "");
    if (!match) return "";
    if (Number(match[1]) < 1900) return "Enter a valid birthdate.";
    if (value > dateKey(new Date())) return "Birthdate cannot be in the future.";
    if (value > birthdateLatest()) return "You must be at least " + MIN_AGE + " years old to submit a request.";
    return "";
  }
  function checkBirthdateNow(field) {
    if (!field || field.id !== "credentialBirthdate") return;
    const problem = birthdateProblem(field.value);
    if (!problem) { if (field.dataset.birthdateNotice) { clearInvalidField(field); delete field.dataset.birthdateNotice; } return; }
    if (field.dataset.birthdateNotice === problem && field._notice) return;      // already showing
    markMissingField(field, problem);
    field.dataset.birthdateNotice = problem;
    field._notice?.querySelector("button")?.click();                               // open the notice right away
  }
  {
    const bd = document.getElementById("credentialBirthdate");
    if (bd) {
      bd.max = birthdateLatest();
      // Also when the browser puts a saved value back (refresh / autofill) or the person leaves the box: no "input" event is fired then.
      ["input", "change", "blur"].forEach(name => bd.addEventListener(name, () => setTimeout(() => checkBirthdateNow(bd), 0)));
      [0, 400, 1200].forEach(ms => setTimeout(() => checkBirthdateNow(bd), ms));
      window.addEventListener("pageshow", () => checkBirthdateNow(bd));
    }
  }

  // Every empty required field of the credential form at once: each one gets a red mark, a short notice and (text boxes) a red placeholder.
  function markMissingField(field, notice) {
    if (!field) return;
    field.setAttribute("aria-invalid", "true");
    if (field._notice) field._notice.remove();
    const host = field.closest("label") || field.parentElement;
    host.classList.add("has-field-notice");
    const wrap = document.createElement("span");
    wrap.className = "field-notice-wrap";
    wrap.innerHTML = '<button type="button" class="field-notice-toggle" aria-expanded="false" aria-label="Show notice"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/></svg></button>'
      + '<span class="field-notice-pop" role="alert" hidden></span>';
    const toggle = wrap.querySelector("button"), pop = wrap.querySelector(".field-notice-pop");
    pop.textContent = notice;
    let hideTimer = null;
    const setOpen = open => {
      clearTimeout(hideTimer);
      pop.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) hideTimer = setTimeout(() => setOpen(false), 30000);    // the notice stays 30 seconds, then hides by itself
    };
    toggle.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      setOpen(pop.hidden);
    });
    host.appendChild(wrap);
    field._notice = wrap;
    // The icon sits inside the field on the right (further left for dropdowns and the date box, which have their own arrow).
    const place = () => {
      const inset = field.tagName === "SELECT" ? 34 : field.type === "date" ? 40 : 10;
      toggle.style.top = (field.offsetTop + field.offsetHeight / 2 - 11) + "px";
      toggle.style.left = (field.offsetLeft + field.offsetWidth - 22 - inset) + "px";
      pop.style.top = (field.offsetTop + field.offsetHeight + 6) + "px";
      pop.style.right = Math.max(0, host.clientWidth - (field.offsetLeft + field.offsetWidth)) + "px";
    };
    place();
    requestAnimationFrame(place);
  }
  // School name and year graduated are typed in two separate boxes and saved together as "School name / year" (the same format as before).
  function schoolAndYear(prefix) {
    const name = document.getElementById(`credential${prefix}Name`).value.trim();
    const year = document.getElementById(`credential${prefix}Year`).value.trim();
    return name && year ? `${name} / ${year}` : "";
  }
  // "Year graduated" is a list of years only (newest first), so nobody has to type it.
  function fillSchoolYears() {
    const thisYear = new Date().getFullYear();
    ["Elementary", "JuniorHigh", "SeniorHigh"].forEach(prefix => {
      const select = document.getElementById(`credential${prefix}Year`);
      if (!select || select.options.length > 1) return;
      for (let year = thisYear; year >= 2000; year--) select.add(new Option(String(year), String(year)));
    });
  }
  fillSchoolYears();
  document.addEventListener("DOMContentLoaded", fillSchoolYears);
  function credentialMissingFields(items = chosenDocuments()) {
    if (!needsCredentialForm(items)) return [];
    const data = credentialFormData(items);
    const $ = id => document.getElementById(id);
    const list = [];
    const need = (empty, id, notice) => { if (empty) list.push({ field: $(id), notice }); };
    need(!data.middle_name, "credentialMiddleName", "Please enter your middle name (type N/A if you have none).");
    need(!data.province, "credentialProvince", "Please choose your province.");
    need(!data.city, "credentialCity", "Please choose your city or municipality.");
    need(!data.barangay, "credentialBarangay", "Please choose your barangay.");
    need(!data.birthdate, "credentialBirthdate", "Please enter your birthdate.");
    { const bdProblem = birthdateProblem(data.birthdate); if (bdProblem) list.push({ field: $("credentialBirthdate"), notice: bdProblem }); }
    need(!data.gender, "credentialGender", "Please choose your gender.");
    need(!data.mobile, "credentialMobile", "Please enter your mobile number.");
    const yearOk = value => /^20\d{2}(-20\d{2})?$/.test(value);
    [["Elementary", "elementary"], ["JuniorHigh", "junior high"], ["SeniorHigh", "senior high"]].forEach(([prefix, label]) => {
      need(!$(`credential${prefix}Name`).value.trim(), `credential${prefix}Name`, `Please enter the name of your ${label} school.`);
      const year = $(`credential${prefix}Year`).value.trim();
      need(!year, `credential${prefix}Year`, `Please select the year you graduated from ${label} school.`);
      need(year && !yearOk(year), `credential${prefix}Year`, "Enter a valid year, for example 2018.");
    });
    if (window.SignaturePad && window.SignaturePad.isEmpty()) list.push({ field: $("signatureCanvas"), notice: "Please sign in the Pen Signature box." });
    return list.filter(entry => entry.field);
  }

  function credentialFormProblem(items = chosenDocuments()) {
    if (!needsCredentialForm(items)) return "";
    const data = credentialFormData(items);
    const today = dateKey(new Date());
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && dateKey(new Date(`${value}T00:00:00`)) === value;
    if (!data.last_name) return { message: "Complete your last name in the credential request form.", field: document.getElementById("credentialLastName"), step: 3 };
    if (!data.first_name) return { message: "Complete your first name in the credential request form.", field: document.getElementById("credentialFirstName"), step: 3 };
    if (!data.province) return { message: "Choose your province in the credential request form.", field: document.getElementById("credentialProvince"), step: 3 };
    if (!data.city) return { message: "Choose your city or municipality in the credential request form.", field: document.getElementById("credentialCity"), step: 3 };
    if (!data.barangay) return { message: "Choose your barangay in the credential request form.", field: document.getElementById("credentialBarangay"), step: 3 };
    if (data.address.length < 5) return { message: "Enter your complete address in the credential request form.", field: document.getElementById("credentialStreet"), step: 3 };
    if (birthdateProblem(data.birthdate)) return { message: birthdateProblem(data.birthdate), field: document.getElementById("credentialBirthdate"), step: 3 };
    if (!validDate(data.birthdate) || data.birthdate > today) return { message: "Enter a valid birthdate in the credential request form.", field: document.getElementById("credentialBirthdate"), step: 3 };
    if (!["Female", "Male"].includes(data.gender)) return { message: "Choose a gender in the credential request form.", field: document.getElementById("credentialGender"), step: 3 };
    if (!/^\+63 9\d{9}$/.test(data.mobile)) return { message: "Enter your mobile number as +63 followed by 10 digits starting with 9 (e.g. +63 9123456789).", field: document.getElementById("credentialMobile"), step: 3 };
    const academicYear = data.academic_year.match(/^(\d{4})-(\d{4})$/);
    if (!academicYear || Number(academicYear[2]) !== Number(academicYear[1]) + 1) return {
      message: "No valid academic year was found for your enrollment. Please ask the registrar to check your student record.",
      field: document.getElementById("credentialAcademicYear"), step: 3
    };
    if (!data.purpose || (data.purpose === "Others" && data.other_purpose.length < 3)) {
      const item = items.find(isCredentialDocument);
      const row = item && documentRows.querySelector(`[data-row-id="${item.rowId}"]`);
      const field = row && row.querySelector(item.purposeChoice === "Others" ? ".request-purpose-other" : ".request-purpose");
      return { message: "Choose or specify the purpose in Step 1.", field, step: field ? 1 : 3 };
    }
    if (window.SignaturePad && window.SignaturePad.isEmpty()) return { message: "Please sign in the Pen Signature box.", field: document.getElementById("signatureCanvas"), step: 3 };
    return "";
  }

  function releaseLabel(items) {
    if (!items.length) return "Choose a document first";
    const first = new Date(Math.min(...items.map(i => i.release.start.getTime())));
    const last = new Date(Math.max(...items.map(i => i.release.end.getTime())));
    return first.getTime() === last.getTime() ? Portal.formatDate(dateKey(first))
      : `${Portal.formatDate(dateKey(first))} – ${Portal.formatDate(dateKey(last))}`;
  }

  // ---------- Requirements and uploads (Purpose step) ----------
  const fileKey = (rowId, requirementId) => `${rowId}:${requirementId}`;

  function renderRequirements(items, container, emptyMessage) {
    container.innerHTML = items.filter(item => item.requirements.length).map(item => `
      <section class="request-requirement-group">
        <h4>${escapeHtml(item.name)}</h4>
        <ul>${item.requirements.map(req => {
          const key = fileKey(item.rowId, req.id);
          const inputId = `file-${item.rowId}-${req.id}`;
          const file = chosenFiles.get(key);
          const types = req.allowed_types.split(",").map(t => t.toUpperCase()).join(", ");
          return `<li class="request-requirement-item">
            <div class="request-requirement-heading"><strong>${escapeHtml(req.name)}</strong>
              <span class="request-required-badge">${req.is_required ? "Required" : "Optional"}</span></div>
            <p class="request-requirement-description">${escapeHtml(req.description || "Upload a file that satisfies this requirement.")}</p>
            <input class="request-required-file" id="${inputId}" type="file" data-key="${escapeHtml(key)}" data-req-id="${req.id}"
              data-max-mb="${req.max_size_mb}" data-types="${escapeHtml(req.allowed_types)}" accept=".${req.allowed_types.split(",").join(",.")}"
              aria-label="Upload ${escapeHtml(req.name)} for ${escapeHtml(item.name)}">
            <div class="upload-box" data-input-id="${inputId}" data-key="${escapeHtml(key)}" data-types="${escapeHtml(req.allowed_types)}" data-max-mb="${req.max_size_mb}" aria-live="polite">${uploadBoxHtml(checks.get(key), chosenFiles.get(key), inputId, types, req.max_size_mb, key)}</div>
            </li>`;
        }).join("")}</ul>
        <label class="request-confirm-option"><input type="checkbox" class="request-requirement-confirm" data-row-id="${escapeHtml(item.rowId)}"
          ${reviewedRows.has(item.rowId) ? "checked" : ""}> I have reviewed these requirements.</label>
      </section>`).join("") || `<p class="request-date-note">${escapeHtml(emptyMessage)}</p>`;
  }

  function redrawUploadBox(key) {
    const box = [...form.querySelectorAll(".upload-box")].find(b => b.dataset.key === key);
    if (!box) return;
    const types = box.dataset.types.split(",").map(t => t.toUpperCase()).join(", ");
    box.innerHTML = uploadBoxHtml(checks.get(key), chosenFiles.get(key), box.dataset.inputId, types, box.dataset.maxMb, key);
  }

  function updateNextButtons() {
    document.querySelectorAll("[data-next-step]").forEach(button => {
      if (button.id === "purposeNextButton") {
        const purposeReady = checksRunning === 0;
        button.disabled = !purposeReady;
        button.title = purposeReady ? "" : "Please wait while your documents are being verified.";
        return;
      }
      if (button.id === "requirementsNextButton") {
        button.disabled = false;
        button.title = "";
        return;
      }
      if (Number(button.dataset.nextStep) < 3) return;
    });
  }

  const VERIFICATION_FIELD_IDS = {
    "Student ID": "studentVerificationId",
    "Student Name": "studentVerificationName",
    "Course/Program": "studentVerificationCourse",
    "Academic Year": "studentVerificationAcademicYear",
    "Grade Level": "studentVerificationGradeLevel"
  };

  function clearVerificationMarks() {
    Object.values(VERIFICATION_FIELD_IDS).forEach(id => {
      const field = document.getElementById(id);
      field.removeAttribute("data-verify");
      field.removeAttribute("aria-invalid");
    });
  }

  // Green for matching fields, red for fields that do not match the student profile.
  function markVerificationFields(checks) {
    clearVerificationMarks();
    (checks || []).forEach(check => {
      const id = VERIFICATION_FIELD_IDS[check.field];
      if (!id) return;
      const field = document.getElementById(id);
      field.dataset.verify = check.passed ? "ok" : "bad";
      if (!check.passed) field.setAttribute("aria-invalid", "true");
    });
  }

  function showVerificationDialog(verified, checks) {
    const wrong = (checks || []).filter(check => !check.passed);
    const dialog = document.createElement("dialog");
    dialog.className = `request-cancel-confirm-dialog verification-dialog ${verified ? "is-verified" : "is-wrong"}`;
    dialog.setAttribute("aria-labelledby", "verificationDialogTitle");
    dialog.innerHTML = `
      <div class="logout-confirm-icon" aria-hidden="true"><span class="material-symbol">${verified ? "check_circle" : "error"}</span></div>
      <h2 id="verificationDialogTitle">${verified ? "Verified" : "Wrong Information"}</h2>
      <p>${verified
        ? "Your student information matches your student profile."
        : "Please correct the fields marked in red, then verify again."}</p>
      ${wrong.length ? `<ul class="verification-dialog-list">${wrong.map(check =>
        `<li><strong>${escapeHtml(check.field)}</strong>: ${escapeHtml(check.result)}</li>`).join("")}</ul>` : ""}
      <div class="logout-confirm-actions">
        <button class="request-next-btn" type="button" data-close-verification>${verified ? "Continue" : "OK"}</button>
      </div>`;
    document.body.append(dialog);
    dialog.showModal();
    return new Promise(resolve => {
      const finish = () => { dialog.close(); dialog.remove(); resolve(); };
      dialog.querySelector("[data-close-verification]").addEventListener("click", finish, { once: true });
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(); }, { once: true });
    });
  }

  async function verifyStudentInformation() {
    const items = chosenDocuments();
    if (checksRunning > 0) { showMessage("Please wait while your required files are being verified."); return; }
    const button = document.getElementById("requirementsNextButton");
    const status = document.getElementById("studentVerificationStatus");
    const statusText = document.getElementById("studentVerificationStatusText");
    const spinner = document.getElementById("studentVerificationSpinner");
    const attempt = ++studentVerificationAttempt;
    const fingerprint = studentVerificationFingerprint(items);
    button.disabled = true;
    status.className = "form-message";
    status.setAttribute("aria-busy", "true");
    statusText.textContent = "Verifying your information against your student profile...";
    spinner.hidden = false;
    try {
      const result = await Api.postJson("requests.php", {
        student_verification_form: studentVerificationFormData(items),
        items: items.map(item => ({ document_id: item.id }))
      }, { action: "verify_student_form" });
      if (attempt !== studentVerificationAttempt || requestFormPanel.hidden) return;
      if (fingerprint !== studentVerificationFingerprint()) {
        status.className = "form-message error";
        statusText.textContent = "The information changed during verification. Verify it again.";
        return;
      }
      studentVerificationCheckedFingerprint = fingerprint;
      status.className = result.verified ? "form-message success" : "form-message error";
      statusText.textContent = result.verified
        ? `Information verified against your profile.\n${result.checks.map(check => `PASS — ${check.field}: ${check.result}`).join("\n")}`
        : `Verification found information that needs correction. Update the fields marked CHECK, then verify again.\n${result.checks.map(check => `${check.passed ? "PASS" : "CHECK"} — ${check.field}: ${check.result}`).join("\n")}`;
      markVerificationFields(result.checks);
      if (result.verified) {
        verifiedStudentInformationFingerprint = fingerprint;
        updateSummary();
        await showVerificationDialog(true, result.checks);
        if (attempt === studentVerificationAttempt && !requestFormPanel.hidden) goToStep(4);
      } else {
        verifiedStudentInformationFingerprint = "";
        await showVerificationDialog(false, result.checks);
        const firstWrong = document.querySelector('#studentVerificationFormSection [data-verify="bad"]');
        if (firstWrong && !firstWrong.readOnly) firstWrong.focus();
      }
    } catch (error) {
      if (attempt !== studentVerificationAttempt || requestFormPanel.hidden) return;
      status.className = "form-message error";
      statusText.textContent = error.message;
      showMessage(error.message);
    } finally {
      if (attempt === studentVerificationAttempt) {
        spinner.hidden = true;
        status.setAttribute("aria-busy", "false");
        button.disabled = false;
        updateNextButtons();
      }
    }
  }

  function forgetFile(key, input) {
    const old = checks.get(key);
    if (old && old.checkId) Api.postJson("verify.php", { id: old.checkId }, { action: "discard" }).catch(() => {});
    chosenFiles.delete(key);
    checks.delete(key);
    if (input) input.value = "";
    updateNextButtons();
  }

  // Shows the result of a check: the box, a message, and enables / disables the Next button.
  function showCheckResult(key, state) {
    checks.set(key, state);
    const messages = { verified: ["success", "Document verified"], declined: ["error", "Verification declined"],
                       needs_correction: ["error", "Needs correction"], pending: ["warning", "Verification not completed"] };
    const [type, title] = messages[state.state];
    Portal.toast(state.message, type, title);
  }

  // Sends the file to the server for verification. The result decides if the student can continue.
  async function verifyFile(key, input, file) {
    const old = checks.get(key);
    chosenFiles.set(key, file);
    checks.set(key, { state: "checking", checkId: null });
    redrawUploadBox(key);
    checksRunning++;
    updateNextButtons();
    try {
      const result = await verifyUpload(file, input.dataset.reqId, old && old.checkId);
      if (chosenFiles.get(key) !== file) {                             // the student picked another file meanwhile
        if (result.id) Api.postJson("verify.php", { id: result.id }, { action: "discard" }).catch(() => {});
        return;
      }
      showCheckResult(key, stateFromCheck(result));
    } catch (error) {
      if (chosenFiles.get(key) !== file) return;
      showCheckResult(key, stateFromError(error));
    } finally {
      checksRunning = Math.max(0, checksRunning - 1);
      redrawUploadBox(key);
      updateNextButtons();
    }
  }

  // "Try Again" after "Verification not completed". The stored file is checked again; if it was never stored the file is sent again.
  async function retryFile(key, input) {
    const state = checks.get(key);
    const file = chosenFiles.get(key);
    if (!file) return;
    if (!state || !state.checkId) { verifyFile(key, input, file); return; }
    checks.set(key, { state: "checking", checkId: state.checkId });
    redrawUploadBox(key);
    checksRunning++;
    updateNextButtons();
    try {
      showCheckResult(key, stateFromCheck(await retryUpload(state.checkId)));
    } catch (error) {
      showCheckResult(key, { ...stateFromError(error), checkId: state.checkId });
    } finally {
      checksRunning = Math.max(0, checksRunning - 1);
      redrawUploadBox(key);
      updateNextButtons();
    }
  }

  // Which required documents are still missing or not yet verified? Returns a list of names.
  function missingRequirements(items) {
    return items.flatMap(item => item.requirements
      .filter(req => req.is_required && !isAccepted(fileKey(item.rowId, req.id)))
      .map(req => `${item.name} - ${req.name}`));
  }
  const isAccepted = key => isVerifiedState(checks.get(key));

  // ---------- Moving between steps ----------
  function purposeProblem(value) {
    const purpose = value.trim();
    if (!purpose) return "Please enter the specific purpose of your request.";
    if (purpose.length < 3) return "Please enter a purpose with at least 3 characters.";
    const letters = purpose.match(/[a-z]/gi) || [];
    const vowels = purpose.match(/[aeiou]/gi) || [];
    if (!letters.length || /(.)\1{4,}/i.test(purpose) || (letters.length >= 8 && vowels.length / letters.length < 0.16)) {
      return "Please enter a meaningful purpose, not random characters.";
    }
    return "";
  }

  function goToStep(next) {
    const selects = [...documentRows.querySelectorAll(".request-document-select")];
    const items = chosenDocuments();
    if (!items.length || items.length !== selects.length) {
      const row = [...documentRows.querySelectorAll(".request-document-row")].find(candidate => {
        const documentId = candidate.querySelector(".request-document-select").value;
        const quantity = Number(candidate.querySelector(".request-quantity").value);
        return !documentId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COPIES;
      });
      const field = row && (!row.querySelector(".request-document-select").value
        ? row.querySelector(".request-document-select")
        : row.querySelector(".request-quantity"));
      showFieldValidation({
        message: "Choose a document and a valid number of copies (1 to 5) for every row.",
        field, step: 1
      });
      return;
    }
    const pending = items.find(item => item.pending_request);
    if (pending) {
      showStep(1);
      showMessage(`You already have 10 requests in progress for "${pending.name}" (latest: ${pending.pending_tracking_no}). You can request it again after one is completed, rejected or cancelled.`);
      Portal.toast(`You already have 10 requests in progress for "${pending.name}".`, "warning", "Request limit reached");
      return;
    }
    if (next >= 2 && !releaseSelect.value) { showStep(1); showMessage("The selected documents do not share a release method. Submit them in separate requests."); return; }
    if (next >= 3) {
      for (const item of items) {
        const row = documentRows.querySelector(`[data-row-id="${item.rowId}"]`);
        const input = item.purposeChoice === "Others" ? row.querySelector(".request-purpose-other") : row.querySelector(".request-purpose");
        const problem = item.purposeChoice ? purposeProblem(item.purpose) : "Please choose the purpose of your request.";
        if (problem) {
          showStep(1);
          input.setAttribute("aria-invalid", "true");
          showMessage(`${item.name}: ${problem}`);
          requestAnimationFrame(() => {
            input.scrollIntoView({ behavior: "smooth", block: "center" });
            input.focus({ preventScroll: true });
          });
          return;
        }
        input.removeAttribute("aria-invalid");
      }
    }
    if (next >= 4) {
      const requirementsStep = requiresRequirementsStep(items) ? 3 : 2;
      const missingFields = credentialMissingFields(items);
      if (missingFields.length) {
        showStep(3);
        clearValidationMarks();
        missingFields.forEach(entry => markMissingField(entry.field, entry.notice));
        showValidationNotification(missingFields.length === 1 ? missingFields[0].notice : "Please complete the " + missingFields.length + " highlighted fields.");
        const firstField = missingFields[0].field;
        requestAnimationFrame(() => { firstField.scrollIntoView({ behavior: "smooth", block: "center" }); firstField.focus({ preventScroll: true }); });
        return;
      }
      const credentialProblem = credentialFormProblem(items);
      if (credentialProblem) { showFieldValidation(credentialProblem); return; }
      const verificationProblem = studentVerificationFormProblem(items);
      if (verificationProblem) { showFieldValidation(verificationProblem); return; }
      if (needsStudentVerificationForm(items)
        && verifiedStudentInformationFingerprint !== studentVerificationFingerprint(items)) {
        showStep(requirementsStep);
        showValidationNotification("Verify the Student Verification information against your profile before continuing.");
        return;
      }
      if (checksRunning > 0) { showStep(requirementsStep); showValidationNotification("Please wait while your documents are being verified."); return; }
      const notOk = items.flatMap(item => item.requirements
        .filter(req => { const st = checks.get(fileKey(item.rowId, req.id)); return st && st.state !== "verified"; })
        .map(req => `${item.name} - ${req.name}`));
      if (notOk.length) {
        showStep(requirementsStep);
        const blocked = items.flatMap(item => item.requirements
          .map(req => ({ item, req, state: checks.get(fileKey(item.rowId, req.id)) }))
          .filter(entry => entry.state && entry.state.state !== "verified"))[0];
        if (blocked && blocked.state.state === "pending") {
          showValidationNotification(`Cannot continue to Review: "${notOk[0]}" is pending. ${blocked.state.message}`);
        } else {
          showValidationNotification(`Cannot continue to Review: the document for "${notOk[0]}" has not passed the pre-check. Please upload a corrected file before continuing.`);
        }
        return;
      }
      const missing = missingRequirements(items);
      if (missing.length) {
        showStep(requirementsStep);
        const missingEntry = items.flatMap(item => item.requirements
          .filter(req => req.is_required && !isAccepted(fileKey(item.rowId, req.id)))
          .map(req => ({ item, req })))[0];
        const input = missingEntry && document.getElementById(`file-${missingEntry.item.rowId}-${missingEntry.req.id}`);
        const dropzone = input?.nextElementSibling?.querySelector(".request-requirement-dropzone");
        showFieldValidation({
          message: `Required document missing: ${missing[0]}${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ""}. Please upload all required documents before continuing.`,
          field: input, step: requirementsStep
        });
        if (dropzone) dropzone.classList.add("is-missing");
        return;
      }
      const unreviewed = items.find(item => item.requirements.length && !reviewedRows.has(item.rowId));
      if (unreviewed) {
        const checkbox = document.querySelector(`.request-requirement-confirm[data-row-id="${unreviewed.rowId}"]`);
        showFieldValidation({
          message: "Confirm that you have reviewed the listed requirements for every selected document.",
          field: checkbox, step: requirementsStep
        });
        return;
      }
    }
    if (next === 4) fillReview(items);
    showStep(next);
  }

  function fillReview(items) {
    const fileNames = items.flatMap(item => item.requirements
      .map(req => { const key = fileKey(item.rowId, req.id); const file = chosenFiles.get(key); return file && isAccepted(key) ? `${item.name} - ${req.name}: ${file.name}` : null; })
      .filter(Boolean));
    const credentialReview = document.getElementById("credentialReview");
    credentialReview.hidden = !needsCredentialForm(items);
    if (!credentialReview.hidden) {
      const data = credentialFormData(items);
      credentialReview.querySelector("strong").textContent = `${data.first_name} ${data.last_name} · ${data.requested_documents.join(", ")}`;
    }
    document.getElementById("reviewAttachments").textContent = fileNames.join(", ") || "None";
    document.getElementById("requestReviewRows").innerHTML = items.map(item => `
      <tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.purpose)}</td><td>${item.quantity}</td><td>${Portal.formatMoney(item.price)}</td>
      <td>${Portal.formatMoney(item.lineTotal)}</td></tr>`).join("");
    document.getElementById("reviewTotal").textContent = Portal.formatMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
  }

  function startRequest(documentId = "") {
    studentVerificationAttempt++;
    Portal.goToPage("My Requests");
    requestFormPanel.hidden = false;
    requestsHistoryCard.hidden = true;
    successPanel.hidden = true;
    document.getElementById("cancelRequestForm").hidden = false;
    form.hidden = false;
    form.reset();
    if (window.SignaturePad) window.SignaturePad.clear();
    clearValidationMarks();
    discardUnusedChecks();
    chosenFiles.clear();
    checks.clear();
    reviewedRows.clear();
    verifiedStudentInformationFingerprint = "";
    studentVerificationCheckedFingerprint = "";
    const verificationStatus = document.getElementById("studentVerificationStatus");
    document.getElementById("studentVerificationStatusText").textContent = "";
    verificationStatus.className = "form-message";
    clearVerificationMarks();
    verificationStatus.setAttribute("aria-busy", "false");
    document.getElementById("studentVerificationSpinner").hidden = true;
    updateNextButtons();
    documentRows.replaceChildren();
    addDocumentRow(documentId);
    showStep(1);
  }

  // Files that were verified but never submitted are removed from the server.
  function discardUnusedChecks() {
    checks.forEach(state => {
      if (state.checkId) Api.postJson("verify.php", { id: state.checkId }, { action: "discard" }).catch(() => {});
    });
  }

  function closeForm() {
    studentVerificationAttempt++;
    document.getElementById("studentVerificationSpinner").hidden = true;
    document.getElementById("studentVerificationStatus").setAttribute("aria-busy", "false");
    discardUnusedChecks();
    chosenFiles.clear();
    checks.clear();
    requestFormPanel.hidden = true;
    requestsHistoryCard.hidden = false;
    successPanel.hidden = true;
    document.getElementById("cancelRequestForm").hidden = false;
    form.hidden = false;
  }

  function confirmCancelRequest() {
    const dialog = document.createElement("dialog");
    dialog.className = "request-cancel-confirm-dialog";
    dialog.setAttribute("aria-labelledby", "cancelRequestConfirmTitle");
    dialog.innerHTML = `
      <div class="logout-confirm-icon" aria-hidden="true"><span class="material-symbol">warning</span></div>
      <h2 id="cancelRequestConfirmTitle">Cancel this request?</h2>
      <p>Your progress will be lost if you cancel this request.</p>
      <div class="logout-confirm-actions">
        <button class="request-back-btn" type="button" data-keep-request>Continue request</button>
        <button class="request-next-btn bad" type="button" data-confirm-cancel>Cancel request</button>
      </div>`;
    document.body.append(dialog);
    dialog.showModal();

    return new Promise(resolve => {
      const finish = confirmed => {
        dialog.close();
        dialog.remove();
        resolve(confirmed);
      };
      dialog.querySelector("[data-keep-request]").addEventListener("click", () => finish(false), { once: true });
      dialog.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish(true), { once: true });
      dialog.addEventListener("cancel", event => {
        event.preventDefault();
        finish(false);
      }, { once: true });
      dialog.addEventListener("click", event => {
        if (event.target === dialog) finish(false);
      });
      dialog.querySelector("[data-keep-request]").focus();
    });
  }

  // ---------- Submit ----------
  // One random token per request form. If the same request is sent twice (double click, refresh, bad network) the server returns the first one.
  const newToken = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
  let submissionToken = newToken();
  let submitting = false;                 // true while the request is being sent: a second click or Enter does nothing
  form.addEventListener("submit", async event => {
    event.preventDefault();
    // Only the actual submit button on step 4 may send the request.
    if (activeStep !== 4 || submitting) return;
    if (event.submitter && event.submitter !== submitButton) return;
    const items = chosenDocuments();
    const missing = missingRequirements(items);
    if (missing.length) { showStep(requiresRequirementsStep(items) ? 3 : 2); showMessage("Required document missing. Please upload all required documents before continuing."); return; }

    if (checksRunning > 0) { showMessage("Please wait while your documents are being verified."); return; }
    const checkIds = {};
    items.forEach(item => item.requirements.forEach(req => {
      const state = checks.get(fileKey(item.rowId, req.id));
      if (state && state.checkId && isAccepted(fileKey(item.rowId, req.id))) checkIds[`${item.rowId}:${req.id}`] = state.checkId;
    }));
    const payload = {
      release_method: releaseSelect.value,
      payment_method: paymentSelect.value,
      credential_form: credentialFormData(items),
      student_verification_form: studentVerificationFormData(items),
      submission_token: submissionToken,
      signature_image: "",                                        // the pen signature is switched off for now
      items: items.map(item => ({ row: item.rowId, document_id: item.id, quantity: item.quantity, purpose: item.purposeChoice, purpose_other: item.purposeOther })),
      checks: checkIds
    };
    const formData = new FormData();
    formData.append("payload", JSON.stringify(payload));

    submitting = true;
    await Portal.busy(submitButton, "Submitting...", async () => {
      try {
        const result = (await Api.postForm("requests.php", formData, { action: "create" })).request;
        try { sessionStorage.removeItem("colmRequestDraft"); sessionStorage.removeItem("colmRequestRows"); sessionStorage.removeItem(FORM_KEY); } catch (error) { /* storage may be off */ }
        latestRequest = { id: result.id, tracking: result.tracking_no, submittedAt: new Date().toISOString(),
          items: items.map(i => ({ name: i.name, price: i.price, quantity: i.quantity, release: i.release.label })) };
        // Only this message is shown. The tracking number and the details are in the email; the number is shown here only
        // when the email could not be sent, so the requester is never left without it.
        document.getElementById("requestSuccessText").textContent = "Please check your inbox (and spam folder) for confirmation and further details."
          + (result.status === "NEEDS_CORRECTION" && result.message ? " " + result.message : "");
        const fallback = document.getElementById("requestTrackingFallback");
        if (result.email_sent) {
          fallback.hidden = true;
        } else {
          document.getElementById("requestTrackingNumber").textContent = result.tracking_no;
          fallback.hidden = false;
        }
        submissionToken = newToken();                                     // the next request gets its own token
        checks.forEach(state => { state.checkId = null; });             // the files now belong to the request
        chosenFiles.clear();
        checks.clear();
        form.hidden = true;
        successPanel.hidden = false;
        prepareSuccessQr(result.id, result.tracking_no);
        document.getElementById("cancelRequestForm").hidden = true;   // nothing left to cancel once submitted
        showStep(5);
        window.reloadRequests();
      } catch (error) {
        showMessage(error.message);
        Portal.toast(error.message, "error", "Request not submitted");
        if (error.data && (error.data.missing || error.data.errors)) showStep(requiresRequirementsStep(items) ? 3 : 2);
        if (error.status === 422 && error.message.includes("requests for")) showStep(1);
      } finally {
        submitting = false;
      }
    });
  });

  // ---------- Events ----------
  Object.values(VERIFICATION_FIELD_IDS).forEach(id => {
    document.getElementById(id).addEventListener("input", event => {
      event.target.removeAttribute("data-verify");
      event.target.removeAttribute("aria-invalid");
    });
  });
  document.getElementById("startNewRequestBtn").addEventListener("click", () => startRequest());
  document.getElementById("cancelRequestForm").addEventListener("click", async () => {
    if (!await confirmCancelRequest()) return;
    clearTimeout(draftTimer);
    try {
      sessionStorage.removeItem("colmRequestDraft");
      sessionStorage.removeItem(ROWS_KEY);
      sessionStorage.removeItem(FORM_KEY);
    } catch (error) { /* storage may be off */ }
    closeForm();
    if (landingFlow) backToLanding();
  });
  document.getElementById("requestSuccessOk").addEventListener("click", () => { closeForm(); backToLanding(); });
  document.getElementById("requestAgainBtn")?.addEventListener("click", () => startRequest());
  document.querySelectorAll("[data-next-step]").forEach(b => b.addEventListener("click", () => {
    const items = chosenDocuments();
    if (b.id === "requirementsNextButton" && needsStudentVerificationForm(items)
      && verifiedStudentInformationFingerprint !== studentVerificationFingerprint(items)) {
      verifyStudentInformation();
      return;
    }
    goToStep(Number(b.dataset.nextStep));
  }));
  document.querySelectorAll("[data-previous-step]").forEach(b => b.addEventListener("click", () => showStep(Number(b.dataset.previousStep))));

  documentRows.addEventListener("change", event => { if (event.target.matches(".request-document-select, .request-quantity")) updateSummary(); });
  documentRows.addEventListener("input", event => {
    if (event.target.matches(".request-quantity")) updateSummary();
    if (event.target.matches(".request-purpose")) { event.target.removeAttribute("aria-invalid"); clearMessage(); }
    if (event.target.matches(".request-purpose-other")) {
      event.target.removeAttribute("aria-invalid");
      clearMessage();
      updateSummary();
    }
  });
  documentRows.addEventListener("click", event => {
    const remove = event.target.closest(".request-remove-btn");
    if (!remove) return;
    const row = remove.closest(".request-document-row");
    if (documentRows.children.length === 1) {
      row.querySelector(".request-document-select").value = "";
      row.querySelector(".request-quantity").value = "1";
    } else {
      row.remove();
    }
    updateSummary();
  });

  form.addEventListener("change", async event => {
    clearInvalidField(event.target);
    const input = event.target.closest(".request-required-file");
    if (input) {
      const key = input.dataset.key;
      const file = input.files[0];
      if (!file) { forgetFile(key, input); redrawUploadBox(key); return; }          // the file dialog was cancelled
      const problem = await fileProblem(file, input);
      if (problem) {
        forgetFile(key, input);
        redrawUploadBox(key);
        Portal.toast(problem.text, "error", problem.title);
        showMessage(problem.text);
        return;
      }
      // The same file cannot be used for two requirements.
      for (const [otherKey, other] of chosenFiles) {
        if (otherKey !== key && other.name === file.name && other.size === file.size && other.lastModified === file.lastModified) {
          input.value = "";
          Portal.toast("You already chose this file for another requirement. Upload a different file.", "error", "Duplicate file");
          return;
        }
      }
      clearMessage();
      verifyFile(key, input, file);
      return;
    }
    const confirm = event.target.closest(".request-requirement-confirm");
    if (confirm) {
      if (confirm.checked) reviewedRows.add(confirm.dataset.rowId); else reviewedRows.delete(confirm.dataset.rowId);
      updateNextButtons();
    }
    if (event.target.closest("#credentialFormSection")) {
      if (event.target.matches('[name="credentialGraduated"]')) syncCredentialGraduationFields();
      updateCredentialPreview();
      updateNextButtons();
    }
    if (event.target.closest("#studentVerificationFormSection")) {
      refreshStudentVerificationState();
      updateNextButtons();
    }
  });

  form.addEventListener("input", event => {
    clearInvalidField(event.target);
    checkBirthdateNow(event.target);
    if (event.target.closest("#credentialFormSection")) {
      if (event.target.matches('[name="credentialGraduated"]')) syncCredentialGraduationFields();
      updateCredentialPreview();
    }
    if (event.target.closest("#studentVerificationFormSection")) refreshStudentVerificationState();
    if (event.target.closest("#credentialFormSection, #studentVerificationFormSection")) updateNextButtons();
  });

  // "Remove file" and "Upload Again"
  form.addEventListener("click", event => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      const key = remove.dataset.remove;
      const input = form.querySelector(`.request-required-file[data-key="${CSS.escape(key)}"]`);
      forgetFile(key, input);
      redrawUploadBox(key);
      return;
    }
    const retry = event.target.closest("[data-retry]");
    if (retry) {
      const key = retry.dataset.retry;
      retryFile(key, form.querySelector(`.request-required-file[data-key="${CSS.escape(key)}"]`));
      return;
    }
    const again = event.target.closest("[data-again]");
    if (again) {
      const input = document.getElementById(again.dataset.again);
      forgetFile(input.dataset.key, input);
      redrawUploadBox(input.dataset.key);
      input.click();
    }
  });

  form.addEventListener("dragover", event => {
    const zone = event.target.closest(".upload-box");
    if (zone) { event.preventDefault(); zone.classList.add("drag-active"); }
  });
  form.addEventListener("dragleave", event => {
    const zone = event.target.closest(".upload-box");
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("drag-active");
  });
  form.addEventListener("drop", event => {
    const zone = event.target.closest(".upload-box");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("drag-active");
    const file = event.dataTransfer?.files?.[0];
    const input = document.getElementById(zone.dataset.inputId);
    if (!file || !input) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  async function loadCatalog() {
    try {
      catalog = (await Api.get("documents.php")).documents;
      renderCatalog();
    } catch (error) {
      docGrid.innerHTML = `<p class="requests-empty">${escapeHtml(error.message)}</p>`;
    }
  }

  // The landing page uses short names ("Certificate of Enrollment (COE)") that may differ from the catalog name
  // ("Certificate of Enrollment"), so match exactly first, then without the "(...)" part, then by the words they share.
  function findCatalogDocument(wantedName, includePending = false) {
    const plain = value => String(value).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
    const words = value => plain(value).split(" ").filter(Boolean);
    const available = catalog.filter(item => includePending || !item.pending_request);
    const wanted = plain(wantedName);
    const exact = available.find(item => String(item.name).trim().toLowerCase() === String(wantedName).trim().toLowerCase())
      || available.find(item => plain(item.name) === wanted);
    if (exact) return exact;
    const wantedWords = words(wantedName);
    const candidates = available
      .filter(item => { const have = words(item.name); return wantedWords.every(w => have.includes(w)) || have.every(w => wantedWords.includes(w)); })
      .sort((a, b) => Math.abs(words(a.name).length - wantedWords.length) - Math.abs(words(b.name).length - wantedWords.length));
    return candidates[0] || null;
  }

  // "There's an existing request": shown instead of the form when the chosen document already has an open request.
  function showExistingRequestNotice(doc) {
    Portal.toast(`You already have 10 requests in progress for "${doc.name}".`, "warning", "Request limit reached");
    const dialog = document.createElement("dialog");
    dialog.className = "request-cancel-confirm-dialog";
    dialog.setAttribute("aria-labelledby", "existingRequestTitle");
    dialog.innerHTML = `
      <div class="logout-confirm-icon" aria-hidden="true"><span class="material-symbol">info</span></div>
      <h2 id="existingRequestTitle">Request limit reached</h2>
      <p>You already have 10 requests for <strong>${escapeHtml(doc.name)}</strong> in progress (latest: ${escapeHtml(doc.pending_tracking_no)}). You can request it again after one is completed, rejected or cancelled.</p>
      <div class="logout-confirm-actions">
        <button class="request-back-btn" type="button" data-close-existing>Close</button>
        <button class="request-next-btn" type="button" data-track-existing>Track my request</button>
      </div>`;
    document.body.append(dialog);
    dialog.showModal();
    const done = tracking => { dialog.close(); dialog.remove(); backToLanding(tracking); };
    dialog.querySelector("[data-close-existing]").addEventListener("click", () => done(""));
    dialog.querySelector("[data-track-existing]").addEventListener("click", () => done(doc.pending_tracking_no));
    dialog.addEventListener("cancel", event => { event.preventDefault(); done(""); });
    dialog.querySelector("[data-track-existing]").focus();
  }

  // Step 1 answers are kept for a page refresh (files cannot be kept, they are picked again).
  const ROWS_KEY = "colmRequestRows";
  function saveStepOneRows() {
    if (!landingFlow) return;
    const row = documentRows.querySelector(".request-document-row");
    if (!row) return;
    try {
      sessionStorage.setItem(ROWS_KEY, JSON.stringify({
        quantity: row.querySelector(".request-quantity").value,
        purpose: row.querySelector(".request-purpose").value,
        purposeOther: row.querySelector(".request-purpose-other").value
      }));
    } catch (error) { /* storage may be off */ }
  }
  function restoreStepOneRows() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(ROWS_KEY) || "null"); } catch (error) { /* storage may be off */ }
    const row = documentRows.querySelector(".request-document-row");
    if (!saved || !row) return false;
    const quantity = row.querySelector(".request-quantity"), purpose = row.querySelector(".request-purpose"), other = row.querySelector(".request-purpose-other");
    const beforeQuantity = quantity.value, beforePurpose = purpose.value;
    if (saved.quantity) quantity.value = saved.quantity;
    if ([...purpose.options].some(o => o.value === saved.purpose)) purpose.value = saved.purpose;
    if (purpose.value === "Others") { other.hidden = false; other.value = saved.purposeOther || ""; }
    updateSummary();
    return quantity.value !== beforeQuantity || purpose.value !== beforePurpose || !!other.value;   // true only when something differs from the empty form
  }
  // After a refresh that brought details back: one pop-up notification (toast), once per refresh.
  function showRestoreNote() {
    Portal.toast("Your details were restored after the page refresh.", "success", "Auto-restored");
  }
  documentRows.addEventListener("input", saveStepOneRows);
  documentRows.addEventListener("change", saveStepOneRows);

  // ---------- Auto-restore of the form ----------
  // Everything typed or chosen in the form (address, birthdate, schools, notes ...) and the step are kept in sessionStorage while the
  // request is open. After a refresh they are put back. (No files are uploaded in this form.)
  function draftFields() {
    return [...form.querySelectorAll("input[id], select[id], textarea[id]")].filter(el =>
      !el.closest("#requestRequirementsList, #requestDocumentRows")
      && !el.readOnly
      && !["file", "password", "button", "submit", "reset", "hidden"].includes(el.type));
  }
  function saveFormDraft() {
    if (!landingFlow || !formDraftReady) return;
    const fields = {};
    draftFields().forEach(el => {
      const value = (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value;
      if (value !== "" && value !== false) fields[el.id] = value;
    });
    try { sessionStorage.setItem(FORM_KEY, JSON.stringify({ step: activeStep, fields })); } catch (error) { /* storage may be off */ }
  }
  let draftTimer = null;
  const scheduleDraftSave = () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveFormDraft, 250); };
  form.addEventListener("input", scheduleDraftSave);
  form.addEventListener("change", scheduleDraftSave);
  window.addEventListener("pagehide", () => {
    if (!landingFlow || requestFormPanel.hidden || activeStep === 5) return;
    clearTimeout(draftTimer);
    saveStepOneRows();
    saveFormDraft();
  });

  const waitFor = async (test, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (test()) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
    return false;
  };
  // Province -> city -> barangay load one after the other from the internet, so each one is chosen only when its list is there.
  async function restoreAddress(fields) {
    const hasOption = (id, value) => {
      const el = document.getElementById(id);
      return !!el && (el.tagName !== "SELECT" || [...el.options].some(option => option.value === value));
    };
    for (const id of ["credentialProvince", "credentialCity", "credentialBarangay"]) {
      const value = fields[id];
      if (!value) break;
      if (!await waitFor(() => hasOption(id, value))) break;
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  async function restoreFormDraft() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(FORM_KEY) || "null"); } catch (error) { /* storage may be off */ }
    if (!saved || !saved.fields) return false;
    const fields = saved.fields;
    // What the form holds before anything is put back (defaults, details filled in from the account): only a difference counts as "restored".
    const snapshot = () => draftFields().map(el => [el.id, (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value]);
    const before = new Map(snapshot());
    draftFields().forEach(el => {
      if (/^credential(Province|City|Barangay)$/.test(el.id)) return;          // restored one by one below
      const value = fields[el.id];
      if (value === undefined) return;
      if (el.type === "checkbox" || el.type === "radio") el.checked = !!value;
      else if (el.tagName === "SELECT") { if (![...el.options].some(option => option.value === value)) return; el.value = value; }
      else el.value = value;
    });
    updateCredentialPreview();
    await restoreAddress(fields);
    updateCredentialPreview();
    const items = chosenDocuments();
    let restoredStep = 1;
    if (Number(saved.step) >= 4) {
      restoredStep = items.some(item => item.requirements.length) ? 3 : 4;
    } else if (Number(saved.step) >= 3 && requiresRequirementsStep(items)) {
      restoredStep = 3;
    }
    if (restoredStep === 4) fillReview(items);
    showStep(restoredStep);
    return snapshot().some(([id, value]) => before.has(id) && before.get(id) !== value);
  }

  // The landing page "Request a Document" form leaves the chosen document here; open the wizard with it picked.
  // The draft stays in sessionStorage until the request is submitted or cancelled, so a refresh does not lose it.
  function startFromLandingPage() {
    let draft = null;
    try { draft = JSON.parse(sessionStorage.getItem("colmRequestDraft") || "null"); } catch (error) { /* storage may be off */ }
    if (!draft || !draft.document) return;
    document.body.classList.remove("dark");          // the landing page flow is always light
    const doc = findCatalogDocument(draft.document, true);
    if (doc && doc.pending_request) {
      if (window.parent !== window) window.parent.postMessage({ colmReady: true }, window.location.origin);
      showExistingRequestNotice(doc);
      return;
    }
    formDraftReady = false;
    startRequest(doc ? String(doc.id) : "");
    const rowsRestored = restoreStepOneRows();
    if (window.parent !== window) window.parent.postMessage({ colmReady: true }, window.location.origin);
    restoreFormDraft().catch(() => false)
      .then(fieldsRestored => { if ((rowsRestored || fieldsRestored) && activeStep < 4) showRestoreNote(); })   // not on the Review step
      .finally(() => { formDraftReady = true; saveFormDraft(); });
  }

  document.addEventListener("portal:ready", async event => {
    if (event.detail.role !== "student") { endLandingFlow(); return; }
    try {
      studentAccount = (await Api.get("students.php", { action: "profile" })).student;
      updateSummary();
      await loadCatalog();
      startFromLandingPage();
    } catch (error) { endLandingFlow(); docGrid.innerHTML = `<p class="requests-empty">${escapeHtml(error.message)}</p>`; }
  });
  document.addEventListener("page:change", event => {
    if (event.detail === "Document Catalog") loadCatalog();
  });
})();