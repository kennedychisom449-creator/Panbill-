
(() => {
  'use strict';

  const walletPanel = document.getElementById('wallet-panel');
  const actions = walletPanel?.querySelector('.wallet-actions');

  if (!walletPanel || !actions ||
      document.getElementById('panbill-wallet-transfer-button')) return;

  // =====================================================
  // FORMATTING
  // =====================================================

  function formatMoney(value) {
    return new Intl.NumberFormat('en-NG', {
      maximumFractionDigits: 2
    }).format(Number(value) || 0);
  }

  function formatNaira(value) {
    return '₦' + formatMoney(value);
  }

  // =====================================================
  // SEND MONEY BUTTON
  // =====================================================

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'panbill-wallet-transfer-button';
  button.innerHTML = '<span class="ico">⇄</span>Send Money';

  actions.insertBefore(button, actions.children[1] || null);

  // =====================================================
  // TRANSFER MODAL
  // =====================================================

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

      <!-- ENTRY SCREEN -->

      <div id="panbill-transfer-entry">
        <p class="muted">
          Send money securely to another PanBill wallet.
        </p>

        <label for="panbill-wallet-transfer-recipient">
          Recipient account number
        </label>

        <input id="panbill-wallet-transfer-recipient"
          inputmode="numeric" autocomplete="off"
          maxlength="10" placeholder="033XXXXXXXX">

        <div id="panbill-transfer-recipient-verification"
          style="display:none;margin:10px 0 16px;padding:12px;
          border-radius:12px;background:rgba(255,255,255,.06);
          border:1px solid rgba(255,255,255,.12)">

          <div style="font-size:12px;opacity:.7">
            Verified Recipient
          </div>

          <div id="panbill-transfer-recipient-name"
            style="font-weight:800;margin-top:5px"></div>

          <div id="panbill-transfer-recipient-verification-status"
            style="font-size:12px;margin-top:5px"></div>
        </div>

        <label for="panbill-wallet-transfer-amount">
          Amount (₦)
        </label>

        <input id="panbill-wallet-transfer-amount"
          type="text" inputmode="numeric"
          autocomplete="off" placeholder="Enter amount">

        <button type="button" class="gold-btn"
          id="panbill-wallet-transfer-review"
          style="width:100%;margin-top:16px">
          Review Transfer
        </button>
      </div>

      <!-- REVIEW SCREEN -->

      <div id="panbill-transfer-review" hidden>
        <div style="text-align:center;padding:16px 0 20px">
          <div style="font-size:13px;opacity:.7">
            You are sending
          </div>

          <div id="panbill-transfer-review-amount"
            style="font-size:30px;font-weight:900;margin-top:8px;
            word-break:break-word"></div>
        </div>

        <div style="border:1px solid rgba(255,255,255,.12);
          border-radius:14px;padding:14px;margin-bottom:16px">

          <div style="font-size:12px;opacity:.65">Recipient</div>

          <div id="panbill-transfer-review-name"
            style="font-weight:800;margin-top:4px"></div>

          <div id="panbill-transfer-review-account"
            style="font-size:13px;opacity:.75;margin-top:4px"></div>

          <div style="border-top:1px solid rgba(255,255,255,.12);
            margin:14px 0"></div>

          <div style="display:flex;justify-content:space-between;
            gap:12px;margin-bottom:10px">
            <span>Transfer amount</span>
            <strong id="panbill-transfer-review-subtotal"></strong>
          </div>

          <div style="display:flex;justify-content:space-between;
            gap:12px;margin-bottom:10px">
            <span>Transfer fee</span>
            <strong id="panbill-transfer-review-fee">₦0</strong>
          </div>

          <div style="border-top:1px solid rgba(255,255,255,.12);
            margin:14px 0"></div>

          <div style="display:flex;justify-content:space-between;
            gap:12px;font-weight:900;font-size:16px">
            <span>Total debit</span>
            <strong id="panbill-transfer-review-total"></strong>
          </div>
        </div>

        <label for="panbill-wallet-transfer-pin">
          Transaction PIN
        </label>

        <input id="panbill-wallet-transfer-pin"
          type="password" inputmode="numeric"
          autocomplete="off" maxlength="4"
          placeholder="Enter your 4-digit PIN">

        <button type="button" class="gold-btn"
          id="panbill-wallet-transfer-confirm"
          style="width:100%;margin-top:16px">
          Confirm & Transfer
        </button>

        <button type="button"
          id="panbill-wallet-transfer-back"
          style="width:100%;margin-top:10px">
          Back
        </button>
      </div>

      <!-- RECEIPT SCREEN -->

      <div id="panbill-transfer-receipt" hidden>

        <div id="panbill-transfer-receipt-paper"
          style="background:#fff;color:#172033;border-radius:16px;
          padding:20px;margin-top:10px">

          <div style="text-align:center;padding-bottom:16px">
            <div style="font-size:25px;font-weight:900;
              letter-spacing:.5px;color:#10254b">PanBill</div>

            <div style="font-size:12px;color:#64748b;margin-top:3px">
              WALLET TRANSFER RECEIPT
            </div>

            <div style="display:inline-block;margin-top:14px;
              padding:7px 14px;border-radius:30px;
              background:#dcfce7;color:#166534;
              font-size:12px;font-weight:800">
              ✓ TRANSFER SUCCESSFUL
            </div>
          </div>

          <div style="text-align:center;padding:12px 0 18px;
            border-bottom:1px dashed #cbd5e1">

            <div style="font-size:12px;color:#64748b">
              Amount transferred
            </div>

            <div id="panbill-receipt-amount"
              style="font-size:30px;font-weight:900;
              color:#10254b;margin-top:5px"></div>
          </div>

          <div style="padding:16px 0;
            border-bottom:1px dashed #cbd5e1">

            <div style="font-size:11px;color:#64748b;
              text-transform:uppercase;font-weight:800">
              Recipient details
            </div>

            <div id="panbill-receipt-recipient"
              style="font-size:16px;font-weight:800;margin-top:9px">
            </div>

            <div id="panbill-receipt-account"
              style="font-size:13px;color:#475569;margin-top:5px">
            </div>
          </div>

          <div style="padding:16px 0;
            border-bottom:1px dashed #cbd5e1">

            <div style="display:flex;justify-content:space-between;
              gap:12px;margin-bottom:10px;font-size:13px">
              <span style="color:#64748b">Transfer amount</span>
              <strong id="panbill-receipt-subtotal"></strong>
            </div>

            <div style="display:flex;justify-content:space-between;
              gap:12px;margin-bottom:10px;font-size:13px">
              <span style="color:#64748b">Transfer fee</span>
              <strong id="panbill-receipt-fee"></strong>
            </div>

            <div style="display:flex;justify-content:space-between;
              gap:12px;font-size:15px;font-weight:900">
              <span>Total debited</span>
              <strong id="panbill-receipt-total"></strong>
            </div>
          </div>

          <div style="padding:16px 0">
            <div style="font-size:11px;color:#64748b;
              text-transform:uppercase;font-weight:800">
              Transaction details
            </div>

            <div style="display:flex;justify-content:space-between;
              gap:12px;margin-top:10px;font-size:12px">
              <span style="color:#64748b">Reference</span>
              <strong id="panbill-receipt-reference"
                style="text-align:right;overflow-wrap:anywhere">
              </strong>
            </div>

            <div style="display:flex;justify-content:space-between;
              gap:12px;margin-top:10px;font-size:12px">
              <span style="color:#64748b">Date and time</span>
              <strong id="panbill-receipt-date"
                style="text-align:right"></strong>
            </div>
          </div>

          <div style="text-align:center;
            border-top:1px dashed #cbd5e1;padding-top:14px;
            font-size:11px;color:#64748b">
            Thank you for using PanBill.
            <br>Keep this receipt for your records.
          </div>
        </div>

        <button type="button" class="gold-btn"
          id="panbill-receipt-print"
          style="width:100%;margin-top:14px">
          Save / Print Receipt
        </button>

        <button type="button"
          id="panbill-receipt-share"
          style="width:100%;margin-top:9px">
          Share Receipt
        </button>

        <button type="button"
          id="panbill-receipt-done"
          style="width:100%;margin-top:9px">
          Done
        </button>
      </div>

      <div class="status"
        id="panbill-wallet-transfer-status"
        role="status" aria-live="polite"></div>
    </section>
  `;

  document.body.appendChild(overlay);

  // =====================================================
  // ELEMENT REFERENCES
  // =====================================================

  const entryScreen = overlay.querySelector('#panbill-transfer-entry');
  const reviewScreen = overlay.querySelector('#panbill-transfer-review');
  const receiptScreen = overlay.querySelector('#panbill-transfer-receipt');

  const recipientInput = overlay.querySelector('#panbill-wallet-transfer-recipient');
  const amountInput = overlay.querySelector('#panbill-wallet-transfer-amount');
  const pinInput = overlay.querySelector('#panbill-wallet-transfer-pin');

  const reviewButton = overlay.querySelector('#panbill-wallet-transfer-review');
  const confirmButton = overlay.querySelector('#panbill-wallet-transfer-confirm');
  const backButton = overlay.querySelector('#panbill-wallet-transfer-back');

  const status = overlay.querySelector('#panbill-wallet-transfer-status');

  const recipientVerification = overlay.querySelector('#panbill-transfer-recipient-verification');
  const recipientNameDisplay = overlay.querySelector('#panbill-transfer-recipient-name');
  const recipientVerificationStatus = overlay.querySelector('#panbill-transfer-recipient-verification-status');

  const reviewAmountDisplay = overlay.querySelector('#panbill-transfer-review-amount');
  const reviewName = overlay.querySelector('#panbill-transfer-review-name');
  const reviewAccount = overlay.querySelector('#panbill-transfer-review-account');
  const reviewSubtotal = overlay.querySelector('#panbill-transfer-review-subtotal');
  const reviewFee = overlay.querySelector('#panbill-transfer-review-fee');
  const reviewTotal = overlay.querySelector('#panbill-transfer-review-total');

  // =====================================================
  // STATE
  // =====================================================

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

  let lastReceiptText = '';

  // =====================================================
  // STATUS AND SCREEN HELPERS
  // =====================================================

  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.add('visible');
    status.classList.toggle('error', error);
  }

  function hideStatus() {
    status.textContent = '';
    status.classList.remove('visible', 'error');
  }

  function showEntryScreen() {
    entryScreen.hidden = false;
    reviewScreen.hidden = true;
    receiptScreen.hidden = true;
  }

  function showReviewScreen() {
    entryScreen.hidden = true;
    reviewScreen.hidden = false;
    receiptScreen.hidden = true;
  }

  function showReceiptScreen() {
    entryScreen.hidden = true;
    reviewScreen.hidden = true;
    receiptScreen.hidden = false;
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

  // =====================================================
  // REQUEST ID / RETRY PROTECTION
  // =====================================================

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

  // =====================================================
  // GET OWN ACCOUNT NUMBER
  // =====================================================

  async function getOwnAccountNumber(userId) {
    if (cachedOwnAccount && cachedOwnAccountUser === userId) {
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

  // =====================================================
  // RECIPIENT VERIFICATION
  // =====================================================

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
        { p_account_number: accountNumber }
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

      recipientNameDisplay.textContent = verifiedRecipientName;

      recipientVerificationStatus.textContent =
        'Account verified successfully';

      recipientVerificationStatus.style.color = '#22c55e';

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
          error?.message || 'Could not verify recipient.';

        recipientVerificationStatus.style.color = '#ef4444';
      }

      return false;
    }
  }

  // =====================================================
  // BUILD TRANSFER RECEIPT
  // =====================================================

  function buildReceipt(response) {
    const reference = String(response?.reference || '').trim();

    if (!reference) {
      throw new Error(
        'The transfer succeeded, but its transaction reference was not returned. Please check your transaction history before making another transfer.'
      );
    }

    const amount = Number(
      response?.amount ?? reviewTransferAmount
    );

    const fee = Number(response?.fee ?? 0);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isFinite(fee) ||
      fee < 0
    ) {
      throw new Error(
        'The transfer succeeded, but the receipt details could not be verified. Please check your transaction history.'
      );
    }

    const total = amount + fee;

    const recipientName =
      verifiedRecipientName || 'PanBill Recipient';

    const maskedAccount =
      reviewRecipient.slice(0, 3) +
      '****' +
      reviewRecipient.slice(-3);

    const transactionDate = new Date();

    const dateText = transactionDate.toLocaleString('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    overlay.querySelector('#panbill-receipt-amount').textContent =
      formatNaira(amount);

    overlay.querySelector('#panbill-receipt-recipient').textContent =
      recipientName;

    overlay.querySelector('#panbill-receipt-account').textContent =
      maskedAccount;

    overlay.querySelector('#panbill-receipt-subtotal').textContent =
      formatNaira(amount);

    overlay.querySelector('#panbill-receipt-fee').textContent =
      formatNaira(fee);

    overlay.querySelector('#panbill-receipt-total').textContent =
      formatNaira(total);

    overlay.querySelector('#panbill-receipt-reference').textContent =
      reference;

    overlay.querySelector('#panbill-receipt-date').textContent =
      dateText;

    lastReceiptText = [
      'PANBILL - WALLET TRANSFER RECEIPT',
      'TRANSFER SUCCESSFUL',
      '',
      `Recipient: ${recipientName}`,
      `Account: ${maskedAccount}`,
      `Amount: ${formatNaira(amount)}`,
      `Fee: ${formatNaira(fee)}`,
      `Total debited: ${formatNaira(total)}`,
      `Reference: ${reference}`,
      `Date: ${dateText}`,
      '',
      'Thank you for using PanBill.'
    ].join('\n');
  }

  // =====================================================
  // PRINT / SAVE RECEIPT
  // =====================================================

  function printReceipt() {
    const paper = overlay.querySelector(
      '#panbill-transfer-receipt-paper'
    );

    const printWindow = window.open('', '_blank');

    if (!printWindow) {
      showStatus(
        'Please allow pop-ups in your browser to print or save the receipt.',
        true
      );
      return;
    }

    printWindow.document.open();

    printWindow.document.write(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport"
          content="width=device-width,initial-scale=1">

        <title>PanBill Transfer Receipt</title>

        <style>
          * { box-sizing: border-box; }

          body {
            margin: 0;
            padding: 24px;
            background: #f1f5f9;
            font-family: Arial, sans-serif;
          }

          .receipt {
            max-width: 480px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            padding: 20px;
          }

          @media print {
            body {
              padding: 0;
              background: white;
            }

            .receipt {
              max-width: none;
            }
          }
        </style>
      </head>

      <body>
        <main class="receipt">${paper.innerHTML}</main>

        <script>
          window.onload = function () {
            setTimeout(function () {
              window.print();
            }, 300);
          };
        <\/script>
      </body>
      </html>
    `);

    printWindow.document.close();
  }

  // =====================================================
  // SHARE RECEIPT
  // =====================================================

  async function shareReceipt() {
    if (!lastReceiptText) {
      showStatus('Receipt details are not available.', true);
      return;
    }

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'PanBill Transfer Receipt',
          text: lastReceiptText
        });
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(lastReceiptText);

        showStatus(
          'Receipt copied. You can now paste and share it.'
        );

        return;
      }

      showStatus(
        'Sharing is not supported by this browser. Use Save / Print Receipt instead.',
        true
      );

    } catch (error) {
      if (error?.name === 'AbortError') return;

      showStatus(
        'Could not share the receipt. Please use Save / Print Receipt.',
        true
      );
    }
  }

  // =====================================================
  // OPEN / CLOSE MODAL
  // =====================================================

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
    if (event.target === overlay) closeTransfer();
  });

  // =====================================================
  // RECEIPT BUTTONS
  // =====================================================

  overlay.querySelector('#panbill-receipt-print')
    .addEventListener('click', printReceipt);

  overlay.querySelector('#panbill-receipt-share')
    .addEventListener('click', shareReceipt);

  overlay.querySelector('#panbill-receipt-done')
    .addEventListener('click', () => {
      if (busy) return;

      overlay.hidden = true;
      hideStatus();

      recipientInput.value = '';
      amountInput.value = '';
      pinInput.value = '';

      clearRecipientVerification();
      showEntryScreen();
    });

  // =====================================================
  // RECIPIENT INPUT
  // =====================================================

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

  // =====================================================
  // AMOUNT INPUT WITH THOUSANDS SEPARATORS
  // =====================================================

  amountInput.addEventListener('input', () => {
    const input = amountInput;

    const cursorPosition =
      input.selectionStart ?? input.value.length;

    const digitsBeforeCursor = input.value
      .slice(0, cursorPosition)
      .replace(/\D/g, '')
      .length;

    const digits = input.value.replace(/\D/g, '');

    const formatted = digits
      ? Number(digits).toLocaleString('en-NG')
      : '';

    input.value = formatted;

    let newCursorPosition = 0;
    let digitCount = 0;

    while (
      newCursorPosition < formatted.length &&
      digitCount < digitsBeforeCursor
    ) {
      if (/\d/.test(formatted[newCursorPosition])) {
        digitCount++;
      }

      newCursorPosition++;
    }

    input.setSelectionRange(
      newCursorPosition,
      newCursorPosition
    );

    if (requestFingerprint) {
      requestFingerprint = '';
      requestId = null;
    }
  });

  // =====================================================
  // REVIEW TRANSFER
  // =====================================================

  reviewButton.addEventListener('click', async () => {
    if (busy) return;

    hideStatus();

    const recipient = recipientInput.value.trim();

    const amount = Number(
      amountInput.value.replace(/,/g, '')
    );

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

      reviewAmountDisplay.textContent =
        formatNaira(reviewTransferAmount);

      reviewName.textContent = verifiedRecipientName;

      reviewAccount.textContent =
        recipient.slice(0, 3) +
        '****' +
        recipient.slice(-3);

      reviewSubtotal.textContent =
        formatNaira(reviewTransferAmount);

      reviewFee.textContent = formatNaira(0);

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

  // =====================================================
  // BACK TO ENTRY SCREEN
  // =====================================================

  backButton.addEventListener('click', () => {
    if (busy) return;

    hideStatus();
    pinInput.value = '';

    showEntryScreen();
  });

  // =====================================================
  // CONFIRM TRANSFER
  // =====================================================

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

      // The database supplies the real P2P reference.
      buildReceipt(response);

      pinInput.value = '';

      requestFingerprint = '';
      requestId = null;

      if (typeof loadWallet === 'function') {
        try {
          await loadWallet();
        } catch (refreshError) {
          console.warn(
            'Wallet refresh after transfer failed:',
            refreshError
          );
        }
      }

      hideStatus();
      showReceiptScreen();

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
