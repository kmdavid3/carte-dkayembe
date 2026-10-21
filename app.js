/* Carte de visite SILS : fiche contact (.vcf), QR code, partage, effets décoratifs.
   Les coordonnées sont lues dans la page : il suffit de modifier le HTML. */
(function () {
  "use strict";

  var card = document.getElementById("carte");
  if (!card) return;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  var toastTimer;

  var person = readPerson();
  linkWhatsApp();
  linkWebsite();
  startClock();
  setupQr();
  setupActions();
  setupTilt();
  document.documentElement.classList.add("js");

  function field(name) { return card.querySelector('[data-field="' + name + '"]'); }
  function text(name) { var el = field(name); return el ? el.textContent.trim() : ""; }
  function hrefValue(name, scheme) {
    var el = field(name);
    var href = el ? el.getAttribute("href") || "" : "";
    return href.indexOf(scheme) === 0 ? decodeURIComponent(href.slice(scheme.length)).split("?")[0].trim() : "";
  }

  function readPerson() {
    var address = field("address");
    return {
      given: text("given"),
      additional: text("additional"),
      family: text("family"),
      title: text("title"),
      org: text("org"),
      tel: hrefValue("tel", "tel:"),
      email: hrefValue("email", "mailto:"),
      website: (card.getAttribute("data-website") || "").trim(),
      locality: address ? address.getAttribute("data-locality") || "" : "",
      country: address ? address.getAttribute("data-country") || "" : ""
    };
  }

  /* Lien WhatsApp déduit du numéro de téléphone. */
  function linkWhatsApp() {
    var link = field("whatsapp");
    var digits = person.tel.replace(/\D/g, "");
    if (!link) return;
    if (digits) link.setAttribute("href", "https://wa.me/" + digits);
    else link.closest("li").hidden = true;
  }

  /* Ligne « Site » affichée seulement si l'adresse publique du site est renseignée. */
  function linkWebsite() {
    var link = field("site");
    if (!link || !/^https?:\/\//.test(person.website)) return;
    link.setAttribute("href", person.website);
    link.closest("li").hidden = false;
  }

  function fullName() { return [person.given, person.additional, person.family].filter(Boolean).join(" "); }

  /* Adresse publique de la carte : attribut data-card-url, sinon page servie en http(s). */
  function cardUrl() {
    var declared = (card.getAttribute("data-card-url") || "").trim();
    if (declared) return declared;
    if (/^https?:$/.test(location.protocol)) return location.href.split("#")[0];
    return "";
  }

  function escapeVcard(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }

  function buildVcard() {
    var lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:" + escapeVcard(person.family) + ";" + escapeVcard(person.given) + ";" + escapeVcard(person.additional) + ";;",
      "FN:" + escapeVcard(fullName())
    ];
    if (person.org) lines.push("ORG:" + escapeVcard(person.org));
    if (person.title) lines.push("TITLE:" + escapeVcard(person.title));
    if (person.tel) lines.push("TEL;TYPE=CELL,VOICE:" + person.tel.replace(/\s/g, ""));
    if (person.email) lines.push("EMAIL;TYPE=INTERNET,WORK:" + person.email);
    if (person.website) lines.push("URL:" + person.website);
    if (person.locality || person.country) {
      lines.push("ADR;TYPE=WORK:;;;" + escapeVcard(person.locality) + ";;;" + escapeVcard(person.country));
    }
    lines.push("END:VCARD");
    return lines.join("\r\n") + "\r\n";
  }

  function vcardFile() {
    var slug = fullName().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contact-sils";
    var name = slug + ".vcf";
    var blob = new Blob([buildVcard()], { type: "text/vcard;charset=utf-8" });
    return { name: name, blob: blob };
  }

  function downloadVcard() {
    var file = vcardFile();
    var url = URL.createObjectURL(file.blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast("Fiche contact téléchargée");
  }

  function setupActions() {
    var save = card.querySelector('[data-action="save"]');
    var share = card.querySelector('[data-action="share"]');
    if (save) save.addEventListener("click", downloadVcard);
    if (share) share.addEventListener("click", shareCard);
  }

  /* Partage : lien de la carte si elle est en ligne, sinon la fiche contact, sinon copie. */
  function shareCard() {
    var url = cardUrl();
    var title = fullName() + " — " + (person.org || "SILS");
    if (url && navigator.share) {
      navigator.share({ title: title, text: person.title ? title + ", " + person.title : title, url: url }).catch(ignoreAbort);
      return;
    }
    var file = vcardFile();
    if (navigator.canShare && window.File) {
      var shared = new File([file.blob], file.name, { type: "text/vcard" });
      if (navigator.canShare({ files: [shared] })) {
        navigator.share({ title: title, files: [shared] }).catch(ignoreAbort);
        return;
      }
    }
    if (url && navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(function () { toast("Lien de la carte copié"); }, function () { downloadVcard(); });
      return;
    }
    downloadVcard();
  }
  function ignoreAbort(error) {
    if (error && error.name !== "AbortError") toast("Partage impossible sur cet appareil");
  }

  /* QR code : « Contact » enregistre directement la fiche ; « Lien » ouvre la carte. */
  function setupQr() {
    var holder = card.querySelector(".qr-code");
    var label = card.querySelector(".qr-label");
    var switcher = card.querySelector(".qr-switch");
    if (!holder) return;
    if (!window.SILSQR) {
      holder.closest(".qr-block").hidden = true;
      return;
    }
    var url = cardUrl();
    if (url && switcher) switcher.hidden = false;

    function render(mode) {
      var useLink = mode === "link" && url;
      try {
        var qr = window.SILSQR.encode(useLink ? url : buildVcard(), "M");
        holder.innerHTML = window.SILSQR.toSvg(qr, { dark: "#17243A", light: "#FFFFFF" });
      } catch (error) {
        holder.closest(".qr-block").hidden = true;
        return;
      }
      var message = useLink ? "Scannez pour ouvrir cette carte" : "Scannez pour enregistrer le contact";
      label.textContent = message;
      holder.setAttribute("aria-label", "QR code : " + message.toLowerCase().replace("scannez pour ", ""));
      if (switcher) {
        switcher.querySelectorAll("button").forEach(function (button) {
          button.setAttribute("aria-pressed", String(button.getAttribute("data-qr-mode") === (useLink ? "link" : "contact")));
        });
      }
    }
    if (switcher) {
      switcher.addEventListener("click", function (event) {
        var button = event.target.closest("[data-qr-mode]");
        if (button) render(button.getAttribute("data-qr-mode"));
      });
    }
    render("contact");
  }

  function startClock() {
    var nodes = document.querySelectorAll("[data-clock]");
    if (!nodes.length || !window.Intl) return;
    var format;
    try {
      format = new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Kinshasa", hour: "2-digit", minute: "2-digit" });
    } catch (error) { return; }
    function tick() {
      var value = format.format(new Date());
      nodes.forEach(function (node) { node.textContent = value; });
    }
    tick();
    setInterval(tick, 10000);
  }

  /* Légère inclinaison et reflet de la carte sous la souris. */
  function setupTilt() {
    card.addEventListener("pointermove", function (event) {
      if (event.pointerType !== "mouse" || reduceMotion.matches || !finePointer.matches) return;
      var rect = card.getBoundingClientRect();
      var nx = (event.clientX - rect.left) / rect.width;
      var ny = (event.clientY - rect.top) / rect.height;
      card.style.transition = "transform .15s ease-out";
      card.style.setProperty("--ry", ((nx - 0.5) * 7).toFixed(2) + "deg");
      card.style.setProperty("--rx", ((0.5 - ny) * 5).toFixed(2) + "deg");
      card.style.setProperty("--gx", (nx * 100).toFixed(1) + "%");
      card.style.setProperty("--gy", (ny * 100).toFixed(1) + "%");
      card.style.setProperty("--glare", "1");
    });
    card.addEventListener("pointerleave", function () {
      card.style.transition = "";
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
      card.style.setProperty("--glare", "0");
    });
  }

  function toast(message) {
    var el = document.querySelector(".toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-visible"); }, 2600);
  }
})();
