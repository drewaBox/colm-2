// Province -> City/Municipality -> Barangay dropdowns for the credential request form.
// Data comes from the public PSGC API (Philippine Statistical Authority codes). If it cannot be reached
// the three dropdowns turn into plain text boxes so the student can still finish the request.
(function () {
  const BASE = "https://psgc.gitlab.io/api";
  const NCR = { code: "__NCR__", name: "Metro Manila (NCR)", region: "130000000000" };
  const $ = id => document.getElementById(id);
  const cache = {};
  let prov, city, brgy, street;

  function get(path) {
    if (!cache[path]) {
      cache[path] = fetch(BASE + path, { headers: { Accept: "application/json" } })
        .then(r => { if (!r.ok) throw new Error("PSGC " + r.status); return r.json(); });
    }
    return cache[path];
  }

  function fill(select, placeholder, items, disabled) {
    select.innerHTML = "";
    const first = document.createElement("option");
    first.value = ""; first.textContent = placeholder;
    select.appendChild(first);
    items.forEach(it => {
      const o = document.createElement("option");
      o.value = it.name; o.textContent = it.name; o.dataset.code = it.code;
      select.appendChild(o);
    });
    select.disabled = !!disabled;
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const code = select => (select.selectedOptions[0] && select.selectedOptions[0].dataset.code) || "";

  function useTextFallback() {
    [[prov, "Province"], [city, "City / Municipality"], [brgy, "Barangay"]].forEach(([sel, label]) => {
      const input = document.createElement("input");
      input.type = "text"; input.id = sel.id; input.className = sel.className;
      input.required = true; input.maxLength = 80; input.placeholder = label;
      sel.replaceWith(input);
    });
    prov = $("credentialProvince"); city = $("credentialCity"); brgy = $("credentialBarangay");
  }

  async function loadProvinces() {
    try {
      const list = (await get("/provinces.json")).map(p => ({ code: p.code, name: p.name })).concat([NCR]).sort(byName);
      fill(prov, "Choose province", list, false);
    } catch (e) { useTextFallback(); }
  }

  async function onProvince() {
    fill(city, "Loading cities...", [], true);
    fill(brgy, "Choose city first", [], true);
    const c = code(prov);
    if (!c) { fill(city, "Choose province first", [], true); return; }
    try {
      const path = c === NCR.code ? "/regions/" + NCR.region.slice(0, 9) + "/cities-municipalities.json"
                                  : "/provinces/" + c + "/cities-municipalities.json";
      const list = (await get(path)).map(x => ({ code: x.code, name: x.name })).sort(byName);
      fill(city, "Choose city / municipality", list, false);
    } catch (e) { fill(city, "Could not load. Reload the page.", [], true); }
  }

  async function onCity() {
    fill(brgy, "Loading barangays...", [], true);
    const c = code(city);
    if (!c) { fill(brgy, "Choose city first", [], true); return; }
    try {
      const list = (await get("/cities-municipalities/" + c + "/barangays.json")).map(x => ({ code: x.code, name: x.name })).sort(byName);
      fill(brgy, "Choose barangay", list, false);
    } catch (e) { fill(brgy, "Could not load. Reload the page.", [], true); }
  }

  function values() {
    return {
      street: street ? street.value.trim() : "",
      barangay: brgy ? brgy.value.trim() : "",
      city: city ? city.value.trim() : "",
      province: prov ? prov.value.trim() : ""
    };
  }

  // "123 Rizal St., Brgy. San Roque, Pulilan, Bulacan" (saved in the same address field the server already uses)
  function compose() {
    const v = values();
    const parts = [v.street, v.barangay ? "Brgy. " + v.barangay.replace(/^Barangay\s+/i, "") : "", v.city, v.province === NCR.name ? "Metro Manila" : v.province];
    const text = parts.filter(Boolean).join(", ");
    const hidden = $("credentialAddress");
    if (hidden) hidden.value = text;
    return text;
  }

  function init() {
    prov = $("credentialProvince"); city = $("credentialCity"); brgy = $("credentialBarangay"); street = $("credentialStreet");
    if (!prov || !city || !brgy) return;
    prov.addEventListener("change", onProvince);
    city.addEventListener("change", onCity);
    loadProvinces();
  }

  window.AddressPicker = { compose, values };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();