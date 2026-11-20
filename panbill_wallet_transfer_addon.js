(() => {
  'use strict';

  const walletPanel = document.getElementById('wallet-panel');
  const actions = walletPanel?.querySelector('.wallet-actions');

  if (
    !walletPanel ||
    !actions ||
    document.getElementById('panbill-wallet-transfer-button')
  ) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'panbill-wallet-transfer-button';
  button.innerHTML = '<span class="ico">⇄</span>Send Money';

  actions.insertBefore(button, actions.children[1] || null);

  const overlay = document.createElement('div');
  overlay.id = 'panbill-wallet-transfer-overlay';
  overlay.className = 'modal-backdrop';
  overlay.hidden = true;
  overlay.style.zIndex = '1200';

  overlay.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true"
      aria-labelledby="panbill-wallet-transfer-title">

      <div class="modal-top">
        <h2 id="panbill-wallet-transfer-title">Send Money</h2>
        <button type="button" class="close"
          id="panbill-wallet-transfer-close">Close</button>
      </div>

      <p class="muted">
        Send money securely to another PanBill wallet.
      </p>

      <label for="panbill-wallet-transfer-recipient">
        Recipient account number
      </label>

      <input
        id="panbill-wallet-transfer-recipient"
        inputmode="numeric"
        autocomplete="off"
        maxlength="10"
        placeholder="033XXXXXXXX"
      >

      <label for="panbill-wallet-transfer-amount">
        Amount (₦)
      </label>

      <input
        id="panbill-wallet-transfer-amount"
        type="number"
        min="1"
        step="1"
        inputmode="numeric"
        placeholder="Enter amount"
      >

      <label for="panbill-wallet-transfer-pin">
        Transaction PIN
      </label>

      <input
        id="panbill-wallet-transfer-pin"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        maxlength="4"
        placeholder="4-digit PIN"
      >

      <button
        type="button"
        class="gold-btn"
        id="panbill-wallet-transfer-submit"
        style="width:100%;margin-top:16px">
        Transfer
      </button>

      <div
        class="status"
        id="panbill-wallet-transfer-status"
        role="status"
        aria-live="polite">
      </div>
    </section>
  `;

  document.body.appendChild(overlay);

  const recipientInput = overlay.querySelector(
    '#panbill-wallet-transfer-recipient'
  );

  const amountInput = overlay.querySelector(
    '#panbill-wallet-transfer-amount'
  );

  const pinInput = overlay.querySelector(
    '#panbill-wallet-transfer-pin'
  );

  const submit = overlay.querySelector(
    '#panbill-wallet-transfer-submit'
  );

  const status = overlay.querySelector(
    '#panbill-wallet-transfer-status'
  );

  let busy = false;
  let cachedOwnAccount = null;
  let cachedOwnAccountUser = null;
  let requestFingerprint = '';
  let requestId = null;

  function showStatus(text, error = false) {
    status.textContent = text;
    status.classList.add('visible');
    status.classList.toggle('error', error);
  }

  function hideStatus() {
    status.textContent = '';
    status.classList.remove('visible', 'error');
  }

  function getFingerprint(recipient, amount) {
    return `${recipient}|${amount}`;
  }

  function ensureRequestId(recipient, amount) {
    const fingerprint = getFingerprint(recipient, amount);

    if (fingerprint !== requestFingerprint || !requestId) {
      if (!window.crypto?.randomUUID) {
        throw new Error(
          'Secure transfer IDs are unavailable in this browser. Please update your browser.'
        );
      }

      requestFingerprint = fingerprint;
      requestId = window.crypto.randomUUID();
    }

    return requestId;
  }

  async function getOwnAccountNumber(userId) {
    if (
      cachedOwnAccount &&
      cachedOwnAccountUser === userId
    ) {
      return cachedOwnAccount;
    }

    const { data, error } = await authClient.rpc(
      'panbill_my_account_number'
    );

    if (error) throw error;

    const account = String(data ?? '').trim();

    if (!/^033\d{7}$/.test(account)) {
      throw new Error(
        'Your PanBill account number could not be verified. Please refresh your wallet.'
      );
    }

    cachedOwnAccount = account;
    cachedOwnAccountUser = userId;

    return account;
  }

  function openTransfer() {
    if (!currentSession || !authClient) {
      showStatus(
        'Please sign in to use wallet transfers.',
        true
      );
      return;
    }

    hideStatus();
    overlay.hidden = false;
    recipientInput.focus();
  }

  function closeTransfer() {
    if (busy) return;

    overlay.hidden = true;
    pinInput.value = '';
  }

  button.addEventListener('click', openTransfer);

  overlay.querySelector(
    '#panbill-wallet-transfer-close'
  ).addEventListener('click', closeTransfer);

  overlay.addEventListener('click', event => {
    if (event.target === overlay) {
      closeTransfer();
    }
  });

  recipientInput.addEventListener('input', () => {
    recipientInput.value = recipientInput.value
      .replace(/\D/g, '')
      .slice(0, 10);
  });

  amountInput.addEventListener('input', () => {
    if (requestFingerprint) {
      requestFingerprint = '';
      requestId = null;
    }
  });

  submit.addEventListener('click', async () => {
    if (busy) return;

    const recipient = recipientInput.value.trim();
    const amount = Number(amountInput.value);
    const pin = pinInput.value.trim();
    const userId = currentSession?.user?.id;

    if (!userId) {
      return showStatus(
        'Your session has expired. Please sign in again.',
        true
      );
    }

    if (!/^033\d{7}$/.test(recipient)) {
      return showStatus(
        'Enter a valid 10-digit account number beginning with 033.',
        true
      );
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return showStatus(
        'Enter a valid positive whole-number amount in naira.',
        true
      );
    }

    if (!/^\d{4}$/.test(pin)) {
      return showStatus(
        'Enter your 4-digit transaction PIN.',
        true
      );
    }

    busy = true;
    submit.disabled = true;
    recipientInput.disabled = true;
    amountInput.disabled = true;
    pinInput.disabled = true;

    showStatus('Verifying recipient and wallet balance…');

    try {
      const ownAccount = await getOwnAccountNumber(userId);

      if (recipient === ownAccount) {
        throw new Error(
          'You cannot transfer money to your own PanBill account.'
        );
      }

      const wallet = await authClient
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .maybeSingle();

      if (wallet.error) throw wallet.error;

      if (!wallet.data) {
        throw new Error(
          'Your wallet balance could not be found. Please refresh and try again.'
        );
      }

      const balance = Number(wallet.data.balance);

      if (!Number.isFinite(balance) || balance < 0) {
        throw new Error(
          'Your wallet balance could not be verified. Please refresh and try again.'
        );
      }

      if (amount > balance) {
        throw new Error(
          'Insufficient wallet balance for this transfer.'
        );
      }

      const p_request_id = ensureRequestId(
        recipient,
        amount
      );

      showStatus(
        'Processing transfer securely. Please do not submit again.'
      );

      const result = await authClient.rpc(
        'panbill_transfer_wallet',
        {
          p_recipient_account_number: recipient,
          p_amount: amount,
          p_transaction_pin: pin,
          p_request_id
        }
      );

      if (result.error) throw result.error;

      const response = result.data;

      if (response?.success === false) {
        throw new Error(
          response.message || 'Transfer failed.'
        );
      }

      const transferStatus = String(
        response?.status ||
        response?.transaction_status ||
        ''
      ).toLowerCase();

      const confirmed =
        response?.success === true ||
        [
          'success',
          'successful',
          'completed',
          'complete'
        ].includes(transferStatus);

      if (!confirmed) {
        throw new Error(
          response?.message ||
          'Transfer result could not be confirmed. Check your transaction history before retrying.'
        );
      }

      showStatus(
        response?.message || 'Transfer successful.'
      );

      pinInput.value = '';
      requestFingerprint = '';
      requestId = null;

      if (typeof loadWallet === 'function') {
        await loadWallet();
      }

    } catch (error) {
      showStatus(
        error?.message ||
        'Transfer could not be completed. Check your transaction history before retrying.',
        true
      );

    } finally {
      busy = false;
      submit.disabled = false;
      recipientInput.disabled = false;
      amountInput.disabled = false;
      pinInput.disabled = false;
    }
  });

})();
