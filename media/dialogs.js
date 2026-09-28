// @ts-check
/* VS Code renders this panel in a sandboxed iframe with no "allow-modals" flag, so
   window.alert/confirm/prompt are silently blocked there (alert does nothing, confirm
   always returns false, prompt always returns null). These replacements do the same
   job as a small in-page dialog. Load before app.js; app.js calls confirmDialog(),
   promptDialog(), alertDialog() instead of the native ones. */
(function () {
  "use strict";

  /** @param {{ message: string, input?: boolean, defaultValue?: string, buttons: any[] }} opts */
  function openModal({ message, input, defaultValue, buttons }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sl-modal-overlay";
      const box = document.createElement("div");
      box.className = "sl-modal-box";
      const msg = document.createElement("div");
      msg.className = "sl-modal-msg";
      msg.textContent = message;
      box.appendChild(msg);

      let inputEl = null;
      if (input) {
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "sl-modal-input";
        inputEl.value = defaultValue || "";
        box.appendChild(inputEl);
      }

      const row = document.createElement("div");
      row.className = "row actions sl-modal-actions";

      function finish(value) {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(value);
      }

      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(input ? null : false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          const primary = buttons.find((b) => b.primary);
          finish(input ? (inputEl ? inputEl.value : "") : primary ? primary.value : true);
        }
      }

      buttons.forEach((b) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn" + (b.primary ? "" : " ghost");
        btn.textContent = b.label;
        btn.addEventListener("click", () => finish(input && b.primary ? (inputEl ? inputEl.value : "") : b.value));
        row.appendChild(btn);
      });

      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey, true);
      if (inputEl) {
        inputEl.focus();
        inputEl.select();
      } else {
        const b = row.querySelector("button");
        if (b) b.focus();
      }
    });
  }

  // the button follows the interface language chosen in Settings
  const cancelLabel = () => (typeof I18N !== "undefined" ? I18N.t("dlg_cancel") : "Cancel");

  window.confirmDialog = (message) =>
    openModal({
      message,
      buttons: [
        { label: cancelLabel(), value: false },
        { label: "OK", value: true, primary: true },
      ],
    });

  window.promptDialog = (message, defaultValue) =>
    openModal({
      message,
      input: true,
      defaultValue,
      buttons: [
        { label: cancelLabel(), value: null },
        { label: "OK", value: "", primary: true },
      ],
    });

  window.alertDialog = (message) => openModal({ message, buttons: [{ label: "OK", value: true, primary: true }] });

  // A dialog with more than the plain OK/Cancel choice — e.g. "Overwrite" vs "Create new".
  // choices: [{ label, value, primary? }]. A Cancel button is always added and resolves to null.
  window.chooseDialog = (message, choices) => openModal({ message, buttons: [...choices, { label: cancelLabel(), value: null }] });
})();
