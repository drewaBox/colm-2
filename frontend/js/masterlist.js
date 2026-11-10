// Master Lists (admin and registrar): imported enrollment rows are retained; older lists are archived only after confirmation.
(function () {
  const form = document.getElementById("masterImportForm");
  if (!form) return;
  const plan = document.getElementById("masterPlan");
  const importButton = document.getElementById("masterImportBtn");
  const yearForm = document.getElementById("masterCurrentYearForm");
  const currentYearInput = document.getElementById("masterCurrentYear");
  const currentYearButton = document.getElementById("masterCurrentYearBtn");
  const enrollmentYear = document.getElementById("masterEnrollmentsYear");
  const enrollmentSemester = document.getElementById("masterEnrollmentsSemester");
  const enrollmentScope = document.getElementById("masterEnrollmentsScope");
  let enrollmentPage = 1;
  let checked = false, checkSeq = 0, checkTimer = null;   // the file is checked automatically; Import list is enabled only after a good check

  function formData(extra, selection = {}) {
    const data = new FormData();
    data.append("csv", selection.file || document.getElementById("masterFile").files[0]);
    data.append("academic_year", selection.academicYear || document.getElementById("masterYear").value.trim());
    data.append("semester", selection.semester || document.getElementById("masterSemester").value);
    Object.entries(extra).forEach(([k, v]) => data.append(k, v));
    return data;
  }
  function setReady(ok) {
    checked = ok;
    importButton.disabled = !ok;
    importButton.textContent = "Import list";
  }
  setReady(false);

  const yearInput = document.getElementById("masterYear");
  // Back to default: the form is cleared (no file chosen, Import list disabled). The message stays so the reason can be read.
  function backToDefault() {
    form.reset();
    yearInput.value = "";                 // empty on purpose: the staff member types the academic year (the grey text is only an example)
    setReady(false);
  }
  backToDefault();

  // Automatic checking: runs by itself as soon as a file is chosen. It looks only at what is IN the file
  // (columns, course, year level 1-4, @gmail.com) - not at the academic year or the semester.
  async function autoCheck() {
    const file = document.getElementById("masterFile").files[0];
    const seq = ++checkSeq;
    setReady(false);
    if (!file) { plan.hidden = true; return; }
    plan.hidden = true;
    try {
      const r = await Api.postForm("masterlist.php", (() => { const d = new FormData(); d.append("csv", file); return d; })(), { action: "check" });
      if (seq !== checkSeq) return;                         // a newer check started meanwhile
      const c = r.counts;
      if (c.INVALID > 0) {
        // Wrong information in the file: only a short pop-up, no long text on the page.
        plan.hidden = true;
        Portal.toast("Wrong format. Please follow the contents of the sample CSV.", "error", "Master list");
        backToDefault();
        return;
      }
      plan.hidden = true;
      Portal.toast(`File checked: ${r.rows} students, no errors. You can now import the list.`, "success", "Master list");
      setReady(true);
    } catch (error) {
      if (seq !== checkSeq) return;
      plan.hidden = true;
      Portal.toast(error.status === 422 ? "Wrong format. Please follow the contents of the sample CSV." : error.message, "error", "Master list");
      backToDefault();
    }
  }
  const scheduleCheck = delay => { clearTimeout(checkTimer); checkTimer = setTimeout(autoCheck, delay); };
  document.getElementById("masterFile").addEventListener("change", () => scheduleCheck(100));

  // Sample CSV the user can download and fill in.
  document.getElementById("masterTemplateBtn").addEventListener("click", () => {
    const csv = "student_id,full_name,course,year,email\r\n"
      + "2026-10001,Juliana Yadao,BSIT - Information Technology,4,juliana.yadao@gmail.com\r\n"
      + "2026-10002,John Emerson Larida,BSTM - Tourism Management,3,john.larida@gmail.com\r\n"
      + "2026-10003,Mark Jennon Gatchalian,BSCRIM - Criminology,1,mark.gatchalian@gmail.com\r\n";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    link.download = "master_list_template.csv";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!checked) { autoCheck(); return; }
    await Portal.busy(importButton, "Importing...", async () => {
      try {
        const selection = {
          file: document.getElementById("masterFile").files[0],
          academicYear: document.getElementById("masterYear").value.trim(),
          semester: document.getElementById("masterSemester").value
        };
        const preview = await Api.postForm("masterlist.php", formData({ dry_run: "1" }, selection), { action: "import" });
        const archived = preview.will_archive || [];
        const archiveMessage = [
          ...archived.map(item => item.label),
          ...(preview.new_list_will_archive ? [`${preview.period} (the new import; older than current A.Y. ${preview.current_academic_year})`] : [])
        ];
        const message = archiveMessage.length
          ? `Import ${preview.period} (${preview.rows} enrollment record(s))?\n\nThis will archive:\n${archiveMessage.map(label => `- ${label}`).join("\n")}\n\nArchived records remain searchable and read-only.`
          : `Import ${preview.period} (${preview.rows} enrollment record(s))?`;
        if (!window.confirm(message)) return;
        const r = await Api.postForm("masterlist.php", formData({
          confirmed_archive_ids: JSON.stringify(archived.map(item => item.id)),
          confirmed_current_academic_year: preview.current_academic_year,
          confirmed_new_list_will_archive: preview.new_list_will_archive ? "1" : "0"
        }, selection), { action: "import" });
        if (r.merge) {
          Portal.toast(r.rows
            ? `${r.period}: ${r.rows} new student(s) added. ${r.already_listed} already in the list were skipped.`
            : `${r.period}: no new students. All ${r.already_listed} students are already in the list.`, "success");
        } else {
          Portal.toast(`${r.period} imported (${r.rows} enrollment records).${r.will_archive.length || r.new_list_will_archive ? " Prior academic-year lists archived." : ""}`, "success");
        }
        backToDefault(); plan.hidden = true; enrollmentPage = 1; loadPeriods(); loadImports(); loadEnrollments();
      } catch (error) {
        Portal.toast(error.message, "error", "Master list");
        plan.hidden = true;
        backToDefault();
      }
    });
  });

  yearForm.addEventListener("submit", async event => {
    event.preventDefault();
    const academicYear = currentYearInput.value.trim();
    await Portal.busy(currentYearButton, "Reviewing...", async () => {
      try {
        const previewData = new FormData();
        previewData.append("academic_year", academicYear);
        previewData.append("preview", "1");
        const preview = await Api.postForm("masterlist.php", previewData, { action: "set_current_year" });
        const archived = preview.will_archive || [];
        const message = archived.length
          ? `Set the current academic year to ${academicYear}?\n\nThis will archive ${archived.length} active list(s):\n${archived.map(item => `• ${item.label}`).join("\n")}\n\nThese records remain searchable and read-only.`
          : `Set the current academic year to ${academicYear}?\n\nPreviously archived lists will not be restored automatically.`;
        if (!window.confirm(message)) return;
        const saveData = new FormData();
        saveData.append("academic_year", academicYear);
        saveData.append("confirmed_archive_ids", JSON.stringify(preview.archive_ids || []));
        saveData.append("confirmed_current_academic_year", preview.current_academic_year);
        const result = await Api.postForm("masterlist.php", saveData, { action: "set_current_year" });
        currentYearInput.value = result.academic_year;
        Portal.toast(`Current academic year set to ${result.academic_year}.${result.archived ? ` ${result.archived} list(s) archived.` : ""}`, "success");
        enrollmentPage = 1;
        await loadPeriods();
        loadImports();
        loadEnrollments();
      } catch (error) {
        Portal.toast(error.message, "error", "Academic year");
      }
    });
  });

  async function loadPeriods() {
    try {
      const periods = await Api.get("masterlist.php", { action: "periods" });
      const selectedYear = enrollmentYear.value || "all";
      enrollmentYear.innerHTML = '<option value="all">All academic years</option>' +
        periods.academic_years.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("");
      enrollmentYear.value = periods.academic_years.includes(selectedYear) || selectedYear === "all" ? selectedYear : "all";
      currentYearInput.value = periods.current_academic_year;
      currentYearInput.readOnly = !periods.can_edit_current_year;
      currentYearButton.hidden = !periods.can_edit_current_year;
    } catch (error) {
      Portal.toast(error.message, "error", "Master list");
    }
  }

  async function loadImports() {
    const body = document.getElementById("masterImports");
    try {
      const rows = (await Api.get("masterlist.php", { action: "imports" })).imports;
      body.innerHTML = rows.length ? rows.map(i => `<tr><td>${escapeHtml(i.academic_year)}</td><td>${escapeHtml(i.semester_label)}</td><td>${i.row_count}</td>
        <td>${escapeHtml(i.status === "ARCHIVED" ? "Archived (read-only)" : "Active")}</td><td>${escapeHtml(i.imported_at)}</td><td>${escapeHtml(i.archived_at || "—")}</td></tr>`).join("")
        : '<tr><td colspan="6" class="requests-empty">No master list imported yet.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6" class="requests-empty">${escapeHtml(error.message)}</td></tr>`; }
  }

  async function loadEnrollments() {
    const body = document.getElementById("masterEnrollments");
    try {
      const result = await Api.get("masterlist.php", {
        action: "current_enrollments",
        academic_year: enrollmentYear.value || "all",
        semester: enrollmentSemester.value,
        scope: enrollmentScope.value,
        page: enrollmentPage
      });
      const yearLabel = result.academic_year === "all" ? "All academic years" : `A.Y. ${result.academic_year}`;
      const semesterLabel = result.semester === "all"
        ? "All semesters"
        : ({"1": "1st Semester", "2": "2nd Semester", "3": "Summer"}[result.semester] || "All semesters");
      document.getElementById("masterEnrollmentsTitle").textContent = `Enrollment records · ${yearLabel} · ${semesterLabel}`;
      body.innerHTML = result.records.length ? result.records.map(row => `<tr>
        <td>${escapeHtml(row.student_no)}</td><td>${escapeHtml(row.student_name)}</td>
        <td>${escapeHtml([row.course, row.year_level].filter(Boolean).join(" / ") || "—")}</td>
        <td>${escapeHtml(row.semester_label)}</td>
        <td>${escapeHtml(row.email || "—")}</td>
        <td>${escapeHtml(row.enrollment_status)}</td>
      </tr>`).join("") : '<tr><td colspan="6" class="requests-empty">No enrollment records match these filters.</td></tr>';
      const pages = Math.max(1, Math.ceil(result.total / result.per_page));
      document.getElementById("masterEnrollmentsPage").textContent = `Page ${result.page} of ${pages} (${result.total} records)`;
      document.getElementById("masterEnrollmentsPrev").disabled = result.page <= 1;
      document.getElementById("masterEnrollmentsNext").disabled = result.page >= pages;
    } catch (error) {
      body.innerHTML = `<tr><td colspan="6" class="requests-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  document.getElementById("masterEnrollmentsPrev").addEventListener("click", () => { enrollmentPage = Math.max(1, enrollmentPage - 1); loadEnrollments(); });
  document.getElementById("masterEnrollmentsNext").addEventListener("click", () => { enrollmentPage++; loadEnrollments(); });
  [enrollmentYear, enrollmentSemester, enrollmentScope].forEach(filter => filter.addEventListener("change", () => {
    enrollmentPage = 1;
    loadEnrollments();
  }));
  document.addEventListener("page:change", event => {
    if (event.detail === "Master Lists") { loadPeriods(); loadImports(); loadEnrollments(); }
  });
})();