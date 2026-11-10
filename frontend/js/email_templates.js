(function () {
  const form = document.getElementById("processingEmailTemplateForm");
  if (!form) return;

  const subject = document.getElementById("processingEmailSubject");
  const body = document.getElementById("processingEmailBody");
  const message = document.getElementById("processingEmailTemplateMessage");
  const preview = document.getElementById("processingEmailPreview");
  let loaded = false;

  async function loadTemplate() {
    if (loaded) return;
    loaded = true;
    try {
      const data = await Api.get("email_templates.php", { action: "get" });
      subject.value = data.template.subject;
      body.value = data.template.body;
      form.dataset.defaults = JSON.stringify(data.defaults);
      document.getElementById("processingEmailPlaceholders").textContent = data.placeholders.join(", ");
      preview.hidden = true;
    } catch (error) {
      loaded = false;
      message.textContent = error.message;
      message.className = "form-message error";
    }
  }

  function showPreview() {
    const sample = {
      student_name: "Juan Dela Cruz",
      tracking_no: "COLM-20261109-12345",
      documents: "Transcript of Records × 1",
      expected_release_date: "November 20, 2026",
      tracking_url: "[Track My Request button]"
    };
    const render = value => value.replace(/{{\s*([a-z_]+)\s*}}/g, (token, key) => sample[key] ?? token);
    preview.textContent = `Subject: ${render(subject.value)}\n\n${render(body.value)}`;
    preview.hidden = false;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    message.textContent = "";
    message.className = "form-message";
    await Portal.busy(form.querySelector('[type="submit"]'), "Saving...", async () => {
      try {
        const result = await Api.postJson("email_templates.php", {
          subject: subject.value,
          body: body.value
        }, { action: "save" });
        message.textContent = result.message;
        message.classList.add("success");
        loaded = false;
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
  });

  document.getElementById("previewProcessingEmailTemplate").addEventListener("click", showPreview);
  document.getElementById("resetProcessingEmailTemplate").addEventListener("click", async event => {
    if (!window.confirm("Restore the default processing email template?")) return;
    await Portal.busy(event.currentTarget, "Restoring...", async () => {
      try {
        const result = await Api.postJson("email_templates.php", {}, { action: "reset" });
        loaded = false;
        await loadTemplate();
        message.textContent = result.message;
        message.className = "form-message success";
        preview.hidden = true;
      } catch (error) {
        message.textContent = error.message;
        message.className = "form-message error";
      }
    });
  });

  document.addEventListener("page:change", event => {
    if (event.detail === "Settings" && window.portalUser?.role === "admin") loadTemplate();
  });
})();
