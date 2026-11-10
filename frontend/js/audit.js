// Staff audit history.
(function () {
  const body = document.getElementById("auditBody");
  if (!body) return;

  const from = document.getElementById("auditFrom");
  const to = document.getElementById("auditTo");
  const action = document.getElementById("auditAction");
  const count = document.getElementById("auditCount");
  const pageLabel = document.getElementById("auditPage");
  const previous = document.getElementById("auditPrev");
  const next = document.getElementById("auditNext");
  let page = 1;
  let requestNumber = 0;
  const actionLabels = {
    file_review: "Reviewed request documents",
    request_deleted: "Deleted rejected request",
    status_for_review: "Sent request for review",
    status_processing: "Moved request to processing",
    status_needs_correction: "Requested corrections",
    status_rejected: "Rejected request",
    status_ready: "Marked request ready for release",
    status_completed: "Completed request",
    payment_confirmed: "Confirmed payment",
    release_date_set: "Set expected release date",
    reinstate: "Reinstated request",
    masterlist_import: "Imported master list",
    masterlist_archive: "Archived master list",
    audit_name_set: "Changed audit display name",
    processing_email_template_saved: "Edited the processing email message",
    processing_email_template_reset: "Restored the default processing email message",
    auto_cancel: "Automatically cancelled request"
  };

  function describe(entry) {
    const label = actionLabels[entry.action] || entry.action.replace(/_/g, " ");
    const transition = entry.old_value || entry.new_value
      ? ` (${[entry.old_value, entry.new_value].filter(Boolean).join(" → ")})`
      : "";
    const details = entry.details ? ` — ${entry.details}` : "";
    return `${label}${transition}${details}`;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(String(value).replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  async function load() {
    const currentRequest = ++requestNumber;
    const params = { page };
    if (from.value) params.from = from.value;
    if (to.value) params.to = to.value;
    if (action.value) params.action = action.value;
    body.innerHTML = '<tr><td colspan="4" class="requests-empty">Loading audit history...</td></tr>';
    try {
      const data = await Api.get("audit.php", params);
      if (currentRequest !== requestNumber) return;
      body.innerHTML = data.entries.length ? data.entries.map(entry => `
        <tr>
          <td>${escapeHtml(entry.by_name || "System")}</td>
          <td>${escapeHtml(describe(entry))}</td>
          <td>${escapeHtml(entry.tracking_no || (entry.request_id ? `Request #${entry.request_id}` : "—"))}</td>
          <td>${escapeHtml(formatDateTime(entry.created_at))}</td>
        </tr>`).join("") : '<tr><td colspan="4" class="requests-empty">No activity found.</td></tr>';
      count.textContent = data.total === 1 ? "1 activity found" : `${data.total} activities found`;
      const pages = Math.max(1, Math.ceil(data.total / data.per_page));
      pageLabel.textContent = `Page ${data.page} of ${pages}`;
      previous.disabled = page <= 1;
      next.disabled = page >= pages;
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      body.innerHTML = `<tr><td colspan="4" class="requests-empty">${escapeHtml(error.message)}</td></tr>`;
      count.textContent = "";
      pageLabel.textContent = "";
      previous.disabled = true;
      next.disabled = true;
    }
  }

  [from, to, action].forEach(filter => filter.addEventListener("change", () => { page = 1; load(); }));
  document.getElementById("auditFiltersReset").addEventListener("click", () => {
    from.value = "";
    to.value = "";
    action.value = "";
    page = 1;
    load();
  });
  previous.addEventListener("click", () => { if (page > 1) { page -= 1; load(); } });
  next.addEventListener("click", () => { page += 1; load(); });
  document.addEventListener("page:change", event => { if (event.detail === "Audit") load(); });
})();
