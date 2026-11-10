// Staff pages (admin/registrar): work queue and staff accounts.
(function () {
  let user = null;

  // ---------- Dashboard: requests that need this person's attention ----------
  async function loadQueue() {
    const body = document.getElementById("queueBody");
    const hint = document.getElementById("queueHint");
    // Admin and registrar: requests waiting for review.
    const wanted = { params: { status: "FOR_REVIEW" }, text: "Requests waiting for review." };
    try {
      const data = await Api.get("requests.php", { action: "list", ...wanted.params });
      let rows = data.requests;
      hint.textContent = wanted.text;
      body.innerHTML = rows.length ? rows.slice(0, 8).map(r => `
        <tr><td>${escapeHtml(r.tracking_no)}</td><td>${escapeHtml(r.full_name)}</td>
        <td>${escapeHtml(r.course || "")}</td><td>${escapeHtml(({ currently_enrolled: "Currently Enrolled", alumni: "Alumni", undergrad: "Undergrad" })[r.student_status] || r.student_status || "")}</td>
        <td>${r.items.map(i => escapeHtml(i.name)).join("<br>")}</td></tr>`).join("")
        : '<tr><td colspan="5" class="requests-empty">Nothing is waiting right now.</td></tr>';
    } catch (error) {
      body.innerHTML = `<tr><td colspan="5" class="requests-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  // ---------- Staff accounts (admin/registrar) ----------
  const staffRoleLabel = role => ({ admin: "Admin", registrar: "Registrar" }[role] || role);
  const usersBody = document.getElementById("usersBody");
  const roleFilter = document.getElementById("userRoleFilter");
  const userStatusFilter = document.getElementById("userStatusFilter");
  let userLoadCounter = 0;

  async function loadUsers() {
    if (!usersBody) return;
    const params = {};
    if (roleFilter.value) params.role = roleFilter.value;
    if (userStatusFilter.value) params.status = userStatusFilter.value;
    const search = document.getElementById("searchInput").value.trim();
    if (search) params.q = search;
    const myTurn = ++userLoadCounter;
    try {
      const users = (await Api.get("users.php", params)).users;
      if (myTurn !== userLoadCounter) return;               // a newer search already started
      usersBody.innerHTML = users.length ? users.map(u => `
        <tr><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.full_name)}</td>
        <td><input class="request-text-input audit-name-input" type="text" maxlength="120" value="${escapeHtml(u.audit_name || "")}" placeholder="Use account name" aria-label="Audit name for ${escapeHtml(u.username)}">
          <button class="request-table-action" type="button" data-save-audit-name="${u.id}">Save name</button></td>
        <td>${escapeHtml(staffRoleLabel(u.role))}</td><td>${u.is_active ? "Active" : "Disabled"}</td>
        <td><button class="request-table-action" type="button" data-toggle-user="${u.id}">${u.is_active ? "Disable" : "Enable"}</button></td></tr>`).join("")
        : '<tr><td colspan="6" class="requests-empty">No users found.</td></tr>';
      document.dispatchEvent(new CustomEvent("table:rendered"));
    } catch (error) {
      if (myTurn !== userLoadCounter) return;
      usersBody.innerHTML = `<tr><td colspan="6" class="requests-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  // Create an Admin or Registrar account. The server checks everything again.
  document.getElementById("userForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.getElementById("userMessage");
    message.className = "form-message";
    const values = {
      full_name: document.getElementById("newFullName").value.trim(),
      username: document.getElementById("newUsername").value.trim(),
      email: document.getElementById("newEmail").value.trim(),
      role: document.getElementById("newRole").value
    };
    // The same checks as the server, so the person gets the answer without waiting.
    const fail = text => { message.textContent = text; message.classList.add("error"); };
    if (!values.full_name || !values.username || !values.role) { fail("Please complete all required fields."); return; }
    await Portal.busy(form.querySelector("button[type=submit]"), "Creating...", async () => {
      try {
        const result = await Api.postJson("users.php", values, { action: "create" });
        form.reset();
        message.textContent = result.message;
        message.classList.add("success");
        loadUsers();
      } catch (error) {
        fail(error.message);
      }
    });
  });

  usersBody?.addEventListener("click", async event => {
    const auditNameButton = event.target.closest("[data-save-audit-name]");
    if (auditNameButton) {
      const row = auditNameButton.closest("tr");
      const auditName = row.querySelector(".audit-name-input").value.trim();
      await Portal.busy(auditNameButton, "Saving...", async () => {
        try {
          const result = await Api.postJson("users.php", {
            id: Number(auditNameButton.dataset.saveAuditName),
            audit_name: auditName
          }, { action: "set_audit_name" });
          Portal.toast(result.message, "success");
          loadUsers();
        } catch (error) {
          Portal.toast(error.message, "error");
        }
      });
      return;
    }
    const toggle = event.target.closest("[data-toggle-user]");
    if (toggle) {
      await Portal.busy(toggle, "Saving...", async () => {
        await Api.postJson("users.php", { id: Number(toggle.dataset.toggleUser) }, { action: "toggle" });
        loadUsers();
      });
      return;
    }
  });
  roleFilter?.addEventListener("change", loadUsers);
  userStatusFilter?.addEventListener("change", loadUsers);
  document.getElementById("userFiltersReset")?.addEventListener("click", () => {
    roleFilter.value = ""; userStatusFilter.value = "";
    document.getElementById("searchInput").value = "";
    loadUsers();
  });

  document.getElementById("searchInput").addEventListener("input", () => {
    if (Portal.currentPage === "Accounts") loadUsers();
  });

  document.addEventListener("page:change", event => {
    user = window.portalUser;
    if (event.detail === "Overview") {
      loadQueue();
      window.loadRequestAnalytics?.();
    }
    if (event.detail === "Accounts") loadUsers();
  });
  document.addEventListener("portal:ready", event => { user = event.detail; });
  // ---------- Settings: check that the free AI tools are installed (admin) ----------
  document.getElementById("aiTestBtn")?.addEventListener("click", async event => {
    const list = document.getElementById("aiTestList");
    list.innerHTML = "<li>Checking...</li>";
    await Portal.busy(event.currentTarget, "Checking...", async () => {
      try {
        const result = await Api.postJson("ai_test.php", {}, {}, 60000);
        list.innerHTML = result.tools.map(t => `<li class="${t.ok ? "tool-ok" : "tool-bad"}"><strong>${t.ok ? "✓" : "✗"} ${escapeHtml(t.name)}</strong><br>${escapeHtml(t.message)}</li>`).join("");
      } catch (error) {
        list.innerHTML = `<li class="tool-bad">${escapeHtml(error.message)}</li>`;
      }
    });
  });

  // Refresh the work queue after a request changed.
  document.addEventListener("requests:changed", () => {
    if (Portal.currentPage === "Overview") {
      loadQueue();
      window.loadRequestAnalytics?.();
    }
  });
})();
