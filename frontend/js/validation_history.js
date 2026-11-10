// Master list validation history of a student (read-only).
//   Admin/registrar: Students page -> "Validation" column and the "History" window.
//   Student: My Profile -> "Master List Validation History" card.
// Older semesters are archived by the Master Lists import (api/masterlist.php); this file only shows them.
const ValidationHistory = (function () {
  const STATUS = {
    VALIDATED: ["Validated", "review-verified"],
    MISMATCH: ["Mismatch", "review-pending"],
    NOT_REGISTERED: ["Not registered", "review-rejected"],
    INVALID: ["Invalid", "review-rejected"],
  };
  const pill = status => { const [label, css] = STATUS[status] || [status, ""]; return `<span class="review-pill ${css}">${escapeHtml(label)}</span>`; };
  const listBadge = (listStatus, archivedAt) => listStatus === "ACTIVE"
    ? '<span class="review-pill review-verified">Current</span>'
    : `<span class="review-pill">Archived</span>${archivedAt ? `<br><small>${escapeHtml(Portal.formatDate(archivedAt, true))}</small>` : ""}`;

  // Used in the Students table: the newest validation of the student, or a dash.
  function cell(validation) {
    if (!validation) return '<span class="muted">Not on a master list</span>';
    return `${pill(validation.validation_status)}<br><small>${escapeHtml(validation.period_label)}${validation.list_status === "ARCHIVED" ? " (archived)" : ""}</small>`;
  }

  function tableHtml(history, emptyText) {
    if (!history.length) return `<p class="requests-empty">${escapeHtml(emptyText)}</p>`;
    return `<div class="requests-table-wrap"><table class="requests-table">
      <thead><tr><th>Semester</th><th>Validation</th><th>Course / Year level on the list</th><th>List</th></tr></thead>
      <tbody>${history.map(h => `<tr>
        <td data-label="Semester"><strong>${escapeHtml(h.semester_label)}</strong><br><small>A.Y. ${escapeHtml(h.academic_year)}</small></td>
        <td data-label="Validation">${pill(h.validation_status)}${h.validation_note ? `<br><small>${escapeHtml(h.validation_note)}</small>` : ""}</td>
        <td data-label="On the list">${escapeHtml([h.course, h.year_level].filter(Boolean).join(" / ") || "—")}</td>
        <td data-label="List">${listBadge(h.list_status, h.archived_at)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // Admin: the "History" window of one student.
  async function openForStudent(studentNo, name) {
    const modal = Portal.openModal(`<h2>Validation history</h2><p><strong>${escapeHtml(name)}</strong> · ${escapeHtml(studentNo)}</p>
      <div id="vhBody"><p class="requests-empty">Loading...</p></div>
      <p><small>Archived semesters are kept for reference and auditing. They are read-only and are never overwritten by a newer import.</small></p>
      <div class="detail-buttons"><button class="request-back-btn" type="button" data-close-modal>Close</button></div>`, true);
    const box = modal.querySelector("#vhBody");
    try {
      const r = await Api.get("masterlist.php", { action: "student_history", student_no: studentNo });
      box.innerHTML = tableHtml(r.history, "This student is not on any imported master list yet.");
    } catch (error) { box.innerHTML = `<div class="notice notice-warning">${escapeHtml(error.message)}</div>`; }
  }

  // Student: the card on My Profile.
  async function loadOwn() {
    const box = document.getElementById("validationHistoryBody");
    if (!box) return;
    try {
      const r = await Api.get("masterlist.php", { action: "my_history" });
      box.innerHTML = tableHtml(r.history, "Your name has not been checked against a master list yet.");
    } catch (error) { box.innerHTML = `<p class="requests-empty">${escapeHtml(error.message)}</p>`; }
  }

  // Students page (admin): the "History" buttons in the table.
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-validation-history]");
    if (button) openForStudent(button.dataset.validationHistory, button.dataset.name || "");
  });
  document.addEventListener("page:change", event => {
    if (window.portalUser?.role === "student" && event.detail === "My Profile") loadOwn();
  });
  document.addEventListener("portal:ready", event => { if (event.detail.role === "student") loadOwn(); });

  return { cell, openForStudent };
})();