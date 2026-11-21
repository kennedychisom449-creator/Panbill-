(() => {
  'use strict';

  const walletPanel = document.getElementById('wallet-panel');
  const actions = walletPanel?.querySelector('.wallet-actions');

  if (
    !walletPanel ||
    !actions ||
    document.getElementById('panbill-wallet-transfer-button')
  ) return;

  // =========================================================
  // MONEY FORMATTING
  // =========================================================

  function formatMoney(amount) {
    return new Intl.NumberFormat('en-NG', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0
    }).format(Number(amount) || 0);
  }

  function formatNaira(amount) {
    return '₦' + formatMoney(amount);
  }

  // =========================================================
  // SEND MONEY BUTTON
  // =========================================================

  const button = document.createElement('button');

  button.type = 'button';
  button.id = 'panbill-wallet-transfer-button';
  button.innerHTML = '<span class="ico">⇄</span>Send Money';

  actions.insertBefore(button, actions.children[1] || null);

  // =========================================================
  // TRANSFER MODAL
  // =========================================================

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
          id="panbill-wallet-transfer-close">
          Close
        </button>
      </div>

      <!-- ENTRY SCREEN -->

      <div id="panbill-transfer-entry">

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

        <!-- RECIPIENT VERIFICATION -->

        <div
          id="panbill-transfer-recipient-verification"
          style="
            display:none;
            margin:10px 0 16px;
            padding:12px;
            border-radius:12px;
            background:rgba(255,255,255,.06);
            border:1px solid rgba(255,255,255,.12);
          ">

          <div style="font-size:12px;opacity:.7">
            Verified Recipient
          </div>

          <div
            id="panbill-transfer-recipient-name"
            style="font-weight:800;margin-top:5px">
          </div>

          <div
            id="panbill-transfer-recipient-verification-status"
            style="font-size:12px;margin-top:5px">
          </div>
        </div>

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

        <button
          type="button"
          class="gold-btn"
          id="panbill-wallet-transfer-review"
          style="width:100%;margin-top:16px">
          Review Transfer
        </button>

      </div>

      <!-- CONFIRMATION SCREEN -->

      <div id="panbill-transfer-review" hidden>

        <div style="
          text-align:center;
          padding:16px 0 20px;
        ">

          <div style="font-size:13px;opacity:.7">
            You are sending
          </div>

          <div
            id="panbill-transfer-review-amount"
            style="
              font-size:30px;
              font-weight:900;
              margin-top:8px;
              word-break:break-word;
            ">
          </div>

        </div>

        <div style="
          border:1px solid rgba(255,255,255,.12);
          border-radius:14px;
          padding:14px;
          margin-bottom:16px;
        ">

          <div style="font-size:12px;opacity:.65">
            Recipient
          </div>

          <div
            id="panbill-transfer-review-name"
            style="font-weight:800;margin-top:4px">
          </div>

          <div
            id="panbill-transfer-review-account"
            style="font-size:13px;opacity:.75;margin-top:4px">
          </div>

          <div style="
            border-top:1px solid rgba(255,255,255,.12);
            margin:14px 0;
          "></div>

          <div style="
            display:flex;
            justify-content:space-between;
            gap:12px;
            margin-bottom:10px;
          ">
            <span>Transfer amount</span>

            <strong id="panbill-transfer-review-subtotal"></strong>
          </div>

          <div style="
            display:flex;
            justify-content:space-between;
            gap:12px;
            margin-bottom:10px;
          ">
            <span>Transfer fee</span>

            <strong id="panbill-transfer-review-fee">
              ₦0
            </strong>
          </div>

          <div style="
            border-top:1px solid rgba(255,255,255,.12);
            margin:14px 0;
          "></div>

          <div style="
            display:flex;
            justify-content:space-between;
            gap:12px;
            font-weight:900;
            font-size:16px;
          ">
            <span>Total debit</span>

            <strong id="panbill-transfer-review-total"></strong>
          </div>

        </div>

        <label for="panbill-wallet-transfer-pin">
          Transaction PIN
        </label>

        <input
          id="panbill-wallet-transfer-pin"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          maxlength="4"
          placeholder="Enter your 4-digit PIN"
        >

        <button
          type="button"
          class="gold-btn"
          id="panbill-wallet-transfer-confirm"
          style="width:100%;margin-top:16px">
          Confirm & Transfer
        </button>

        <button
          type="button"
          id="panbill-wallet-transfer-back"
          style="width:100%;margin-top:10px">
          Back
        </button>

      </div>

      <div
        class="status"
        id="panbill-wallet-transfer-status"
        role="status"
        aria-live="polite">
      </div>

    </section>
  `;

  document.body.appendChild(overlay);

  // =========================================================
  // ELEMENT REFERENCES
  // =========================================================

  const entryScreen = overlay.querySelector(
    '#panbill-transfer-entry'
  );

  const reviewScreen = overlay.querySelector(
    '#panbill-transfer-review'
  );

  const recipientInput = overlay.querySelector(
    '#panbill-wallet-transfer-recipient'
  );

  const amountInput = overlay.querySelector(
    '#panbill-wallet-transfer-amount'
  );

  const pinInput = overlay.querySelector(
    '#panbill-wallet-transfer-pin'
  );

  const reviewButton = overlay.querySelector(
    '#panbill-wallet-transfer-review'
  );

  const confirmButton = overlay.querySelector(
    '#panbill-wallet-transfer-confirm'
  );

  const backButton = overlay.querySelector(
    '#panbill-wallet-transfer-back'
  );

  const status = overlay.querySelector(
    '#panbill-wallet-transfer-status'
  );

  const recipientVerification = overlay.querySelector(
    '#panbill-transfer-recipient-verification'
  );

  const recipientNameDisplay = overlay.querySelector(
    '#panbill-transfer-recipient-name'
  );

  const recipientVerificationStatus = overlay.querySelector(
    '#panbill-transfer-recipient-verification-status'
  );

  const reviewAmountDisplay = overlay.querySelector(
    '#panbill-transfer-review-amount'
  );

  const reviewName = overlay.querySelector(
    '#panbill-transfer-review-name'
  );

  const reviewAccount = overlay.querySelector(
    '#panbill-transfer-review-account'
  );

  const reviewSubtotal = overlay.querySelector(
    '#panbill-transfer-review-subtotal'
  );

  const reviewFee = overlay.querySelector(
    '#panbill-transfer-review-fee'
  );

  const reviewTotal = overlay.querySelector(
    '#panbill-transfer-review-total'
  );

  // =========================================================
  // STATE
  // =========================================================

  let busy = false;

  let cachedOwnAccount = null;
  let cachedOwnAccountUser = null;

  let requestFingerprint = '';
  let requestId = null;

  let verifiedRecipientAccount = '';
  let verifiedRecipientName = '';

  let verificationTimer = null;
  let verificationRequestNumber = 0;

  let reviewRecipient = '';
  let reviewTransferAmount = 0;

  // =========================================================
  // STATUS HELPERS
  // =========================================================

  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.add('visible');
    status.classList.toggle('error', error);
  }

  function hideStatus() {
    status.textContent = '';
    status.classList.remove('visible', 'error');
  }

  function hideRecipientVerification() {
    recipientVerification.style.display = 'none';

    recipientNameDisplay.textContent = '';

    recipientVerificationStatus.textContent = '';

    recipientVerificationStatus.style.color = '';

    verifiedRecipientAccount = '';
    verifiedRecipientName = '';
  }

  function clearRecipientVerification() {
    verificationRequestNumber++;

    if (verificationTimer) {
      clearTimeout(verificationTimer);
      verificationTimer = null;
    }

    hideRecipientVerification();
  }

  function showEntryScreen() {
    entryScreen.hidden = false;
    reviewScreen.hidden = true;
  }

  function showReviewScreen() {
    entryScreen.hidden = true;
    reviewScreen.hidden = false;
  }

  // =========================================================
  // REQUEST ID / RETRY PROTECTION
  // =========================================================

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

  // =========================================================
  // GET OWN ACCOUNT NUMBER
  // =========================================================

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

  // =========================================================
  // RECIPIENT VERIFICATION
  // =========================================================

  async function verifyTransferRecipient() {
    const accountNumber = recipientInput.value.trim();

    if (!/^033\d{7}$/.test(accountNumber)) {
      clearRecipientVerification();
      return false;
    }

    if (
      verifiedRecipientAccount === accountNumber &&
      verifiedRecipientName
    ) {
      return true;
    }

    const currentRequest = ++verificationRequestNumber;

    recipientVerification.style.display = 'block';

    recipientNameDisplay.textContent = '';

    recipientVerificationStatus.textContent =
      'Verifying account...';

    recipientVerificationStatus.style.color = '';

    try {
      const { data, error } = await authClient.rpc(
        'panbill_verify_transfer_recipient',
        {
          p_account_number: accountNumber
        }
      );

      if (error) throw error;

      if (
        currentRequest !== verificationRequestNumber ||
        recipientInput.value.trim() !== accountNumber
      ) {
        return false;
      }

      if (!data || data.success !== true) {
        throw new Error(
          data?.message || 'Recipient verification failed.'
        );
      }

      verifiedRecipientAccount = accountNumber;

      verifiedRecipientName =
        String(data.recipient_name || '').trim();

      if (!verifiedRecipientName) {
        throw new Error(
          'The recipient name could not be verified.'
        );
      }

      recipientNameDisplay.textContent =
        verifiedRecipientName;

      recipientVerificationStatus.textContent =
        'Account verified successfully';

      recipientVerificationStatus.style.color =
        '#22c55e';

      return true;

    } catch (error) {
      if (
        currentRequest === verificationRequestNumber &&
        recipientInput.value.trim() === accountNumber
      ) {
        verifiedRecipientAccount = '';
        verifiedRecipientName = '';

        recipientNameDisplay.textContent = '';

        recipientVerificationStatus.textContent =
          error?.message ||
          'Could not verify recipient.';

        recipientVerificationStatus.style.color =
          '#ef4444';
      }

      return false;
    }
  }

  // =========================================================
  // OPEN / CLOSE
  // =========================================================

  function openTransfer() {
    if (!currentSession || !authClient) {
      showStatus(
        'Please sign in to use wallet transfers.',
        true
      );
      return;
    }

    hideStatus();

    showEntryScreen();

    overlay.hidden = false;

    recipientInput.focus();
  }

  function closeTransfer() {
    if (busy) return;

    overlay.hidden = true;

    pinInput.value = '';

    showEntryScreen();
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

  // =========================================================
  // RECIPIENT INPUT
  // =========================================================

  recipientInput.addEventListener('input', () => {
    recipientInput.value = recipientInput.value
      .replace(/\D/g, '')
      .slice(0, 10);

    clearRecipientVerification();

    const accountNumber = recipientInput.value.trim();

    if (/^033\d{7}$/.test(accountNumber)) {
      verificationTimer = setTimeout(() => {
        verifyTransferRecipient();
      }, 450);
    }
  });

  recipientInput.addEventListener('blur', () => {
    if (verificationTimer) {
      clearTimeout(verificationTimer);
      verificationTimer = null;
    }

    verifyTransferRecipient();
  });

  // =========================================================
  // AMOUNT INPUT
  // =========================================================

  amountInput.addEventListener('input', () => {
    if (requestFingerprint) {
      requestFingerprint = '';
      requestId = null;
    }
  });

  // =========================================================
  // REVIEW TRANSFER
  // =========================================================

  reviewButton.addEventListener('click', async () => {
    if (busy) return;

    hideStatus();

    const recipient = recipientInput.value.trim();

    const amount = Number(amountInput.value);

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

    if (
      verifiedRecipientAccount !== recipient ||
      !verifiedRecipientName
    ) {
      showStatus('Verifying recipient account...');

      const verified = await verifyTransferRecipient();

      if (!verified) {
        return showStatus(
          'Please enter a valid verified recipient account number.',
          true
        );
      }
    }

    busy = true;

    reviewButton.disabled = true;

    recipientInput.disabled = true;

    amountInput.disabled = true;

    showStatus('Checking wallet balance...');

    try {
      const ownAccount =
        await getOwnAccountNumber(userId);

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
          'Your wallet balance could not be found. Please refresh your wallet.'
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

      const verified = await verifyTransferRecipient();

      if (!verified) {
        throw new Error(
          'Recipient verification failed. Please check the account number.'
        );
      }

      reviewRecipient = recipient;
      reviewTransferAmount = amount;

      // Format the review screen amount
      reviewAmountDisplay.textContent =
        formatNaira(reviewTransferAmount);

      reviewName.textContent =
        verifiedRecipientName;

      reviewAccount.textContent =
        recipient.slice(0, 3) +
        '****' +
        recipient.slice(-3);

      reviewSubtotal.textContent =
        formatNaira(reviewTransferAmount);

      reviewFee.textContent =
        formatNaira(0);

      reviewTotal.textContent =
        formatNaira(reviewTransferAmount);

      pinInput.value = '';

      hideStatus();

      showReviewScreen();

      pinInput.focus();

    } catch (error) {
      showStatus(
        error?.message ||
        'Could not prepare transfer confirmation.',
        true
      );

    } finally {
      busy = false;

      reviewButton.disabled = false;

      recipientInput.disabled = false;

      amountInput.disabled = false;
    }
  });

  // =========================================================
  // BACK TO ENTRY SCREEN
  // =========================================================

  backButton.addEventListener('click', () => {
    if (busy) return;

    hideStatus();

    pinInput.value = '';

    showEntryScreen();
  });

  // =========================================================
  // CONFIRM TRANSFER
  // =========================================================

  confirmButton.addEventListener('click', async () => {
    if (busy) return;

    const recipient = reviewRecipient;

    const amount = reviewTransferAmount;

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
        'Recipient account number is invalid.',
        true
      );
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return showStatus(
        'Transfer amount is invalid.',
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

    confirmButton.disabled = true;

    backButton.disabled = true;

    pinInput.disabled = true;

    showStatus(
      'Processing transfer securely. Please do not submit again.'
    );

    try {
      const verified = await verifyTransferRecipient();

      if (
        !verified ||
        verifiedRecipientAccount !== recipient
      ) {
        throw new Error(
          'Recipient verification failed. Please go back and verify the recipient again.'
        );
      }

      const ownAccount =
        await getOwnAccountNumber(userId);

      if (recipient === ownAccount) {
        throw new Error(
          'You cannot transfer money to your own PanBill account.'
        );
      }

      const p_request_id = ensureRequestId(
        recipient,
        amount
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

      confirmButton.disabled = false;

      backButton.disabled = false;

      pinInput.disabled = false;
    }
  });

})();
