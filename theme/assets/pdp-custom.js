import { CartUpdateEvent } from '@theme/events';

const ROOT = window.Shopify?.routes?.root || '/';

async function cartRequest(path, body) {
  const res = await fetch(`${ROOT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.description || data.message || 'Something went wrong, please try again.');
  }
  return data;
}


class PdpVariants extends HTMLElement {
  connectedCallback() {
    this.rows = [...this.querySelectorAll('[data-variant-id]')];
    this.errorEl = this.querySelector('[data-error]');

    this.addEventListener('change', this.onChange);
    this.addEventListener('click', this.onClick);
    this.addEventListener('submit', this.onSubmit);

    if (this.dataset.quoteOnly !== 'true') this.loadCart();
  }

  onChange = (event) => {
    if (!event.target.matches('[data-variant-radio]')) return;
    const variantId = event.target.value;

    const url = new URL(window.location.href);
    url.searchParams.set('variant', variantId);
    window.history.replaceState({}, '', url);

    document.dispatchEvent(new CustomEvent('pdp:variant-change', { detail: { variantId } }));
  };


  onClick = (event) => {
    const button = event.target.closest('[data-increase], [data-decrease]');
    if (!button) return;

    const row = button.closest('[data-variant-id]');
    const qty = Number(row.dataset.qty);
    this.setQuantity(row, button.hasAttribute('data-increase') ? qty + 1 : qty - 1);
  };

  onSubmit = (event) => {
    if (!event.target.matches('[data-add-form]')) return;
    event.preventDefault();
    this.setQuantity(event.target.closest('[data-variant-id]'), 1);
  };

  async loadCart() {
    try {
      this.applyCart(await cartRequest('cart.js'));
    } catch {
    }
  }

  applyCart(cart) {
    const lines = {};
    for (const item of cart.items) {
      if (!lines[item.variant_id]) lines[item.variant_id] = item;
    }
    for (const row of this.rows) {
      const line = lines[row.dataset.variantId];
      row.dataset.key = line ? line.key : '';
      this.renderRow(row, line ? line.quantity : 0);
    }
  }

  renderRow(row, qty) {
    const addButton = row.querySelector('[data-add]');
    const stepper = row.querySelector('[data-stepper]');
    if (!addButton || !stepper) return;

    row.dataset.qty = qty;
    addButton.closest('form').hidden = qty > 0;
    stepper.hidden = qty === 0;
    row.querySelector('[data-qty]').textContent = qty;

    const max = row.dataset.max === '' ? Infinity : Number(row.dataset.max);
    row.querySelector('[data-increase]').disabled = qty >= max;
  }

  async setQuantity(row, qty) {
    if (this.busy) return;
    this.setBusy(row, true);
    this.showError('');

    try {
      let cart;
      if (row.dataset.key) {
        cart = await cartRequest('cart/change.js', { id: row.dataset.key, quantity: qty });
      } else {
        await cartRequest('cart/add.js', { items: [{ id: Number(row.dataset.variantId), quantity: qty }] });
        cart = await cartRequest('cart.js');
      }

      this.applyCart(cart);
      document.dispatchEvent(
        new CartUpdateEvent(cart, this.id, { itemCount: cart.item_count, source: 'pdp-custom' })
      );
    } catch (error) {
      this.showError(error.message);
    } finally {
      this.setBusy(row, false);
    }
  }

  setBusy(row, busy) {
    this.busy = busy;
    this.toggleAttribute('data-busy', busy);
    row.classList.toggle('is-loading', busy);
    row.setAttribute('aria-busy', busy);
  }

  showError(message) {
    if (!this.errorEl) return;
    this.errorEl.textContent = message;
    this.errorEl.hidden = !message;
  }
}


class PdpQuote extends HTMLElement {
  connectedCallback() {
    this.dialog = this.querySelector('dialog');
    this.form = this.querySelector('[data-form]');
    this.submitButton = this.querySelector('[data-submit]');
    this.messageEl = this.querySelector('[data-message]');

    this.querySelector('[data-open]').addEventListener('click', () => this.open());
    this.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => this.close()));
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.close();
    });
    this.dialog.addEventListener('close', this.onDialogClose);
    this.form.addEventListener('submit', this.onSubmit);
    document.addEventListener('pdp:variant-change', this.onVariantChange);
  }

  disconnectedCallback() {
    this.cancelRedirect();
    document.removeEventListener('pdp:variant-change', this.onVariantChange);
  }

  onVariantChange = (event) => {
    const select = this.form.elements.variantId;
    if (select && select.tagName === 'SELECT') select.value = event.detail.variantId;
  };

  open() {
    const checked = document.querySelector('[data-variant-radio]:checked');
    const select = this.form.elements.variantId;
    if (checked && select?.tagName === 'SELECT') select.value = checked.value;

    this.dialog.showModal();
    this.form.elements.name.focus();
  }

  close() {
    this.dialog.close();
  }

  onDialogClose = () => {
    this.cancelRedirect();

    if (!this.form.hidden) return;
    this.form.reset();
    this.form.hidden = false;
    this.querySelector('[data-success]').hidden = true;
    this.dialog.classList.remove('is-success');
  };

  onSubmit = async (event) => {
    event.preventDefault();
    this.clearErrors();
    this.setLoading(true);

    const payload = Object.fromEntries(new FormData(this.form));

    try {
      const res = await fetch(this.dataset.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        this.showFieldErrors(data.errors);
        this.showMessage(data.message || 'Could not send your request, please try again.');
        return;
      }

      this.showSuccess(data.message);
    } catch {
      this.showMessage('Network error, please check your connection and try again.');
    } finally {
      this.setLoading(false);
    }
  };

  showSuccess(message) {
    this.form.hidden = true;
    this.dialog.classList.add('is-success');

    const success = this.querySelector('[data-success]');
    success.querySelector('[data-success-text]').textContent = message;
    success.hidden = false;
    success.querySelector('a, button')?.focus();

    this.startRedirect();
  }

  startRedirect() {
    const url = this.dataset.redirectUrl;
    let secondsLeft = Number(this.dataset.redirectDelay) || 0;
    if (!url || secondsLeft <= 0) return;

    const countdown = this.querySelector('[data-countdown]');
    const tick = () => {
      countdown.textContent = `Taking you to our products in ${secondsLeft}s…`;
      countdown.hidden = false;
      if (secondsLeft === 0) {
        clearInterval(this.redirectTimer);
        window.location.assign(url);
      }
      secondsLeft -= 1;
    };

    tick();
    this.redirectTimer = setInterval(tick, 1000);
  }

  cancelRedirect() {
    clearInterval(this.redirectTimer);
    this.redirectTimer = null;
    const countdown = this.querySelector('[data-countdown]');
    if (countdown) countdown.hidden = true;
  }

  setLoading(loading) {
    this.submitButton.disabled = loading;
    this.submitButton.classList.toggle('is-loading', loading);
    this.submitButton.setAttribute('aria-busy', loading);
  }

  showFieldErrors(errors = {}) {
    let first = null;
    for (const [field, message] of Object.entries(errors)) {
      const input = this.form.elements[field];
      const errorEl = this.querySelector(`[data-error-for="${field}"]`);
      if (errorEl) errorEl.textContent = message;
      if (input && input.setAttribute) {
        input.setAttribute('aria-invalid', 'true');
        first ||= input;
      }
    }
    first?.focus();
  }

  showMessage(message) {
    this.messageEl.textContent = message;
    this.messageEl.hidden = false;
  }

  clearErrors() {
    this.messageEl.hidden = true;
    this.querySelectorAll('[data-error-for]').forEach((el) => (el.textContent = ''));
    this.form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  }
}

if (!customElements.get('pdp-variants')) customElements.define('pdp-variants', PdpVariants);
if (!customElements.get('pdp-quote')) customElements.define('pdp-quote', PdpQuote);
