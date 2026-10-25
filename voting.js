// voting.js — paid public voting for the Outstanding Headteacher & Principal Awards 2026.
// Rules: KSh 15 per vote, unlimited votes per person, results hidden until the
// poll closes, only an admin (holding ADMIN_KEY) can create polls.
// A vote counts only after payment is confirmed. Confirmation happens through the
// Lipwa callback OR when the voter's page checks payment status, so a missed
// callback will not lose a paid vote. Both paths are idempotent.

const crypto = require('crypto');

const VOTE_PRICE_KES = 15;
const DEFAULT_CLOSES_AT = Date.parse('2026-11-30T23:59:59+03:00'); // end of 30 Nov, Nairobi time
const LIPWA_BASE = 'https://pay.lipwa.app/api';
const REF_PREFIX = 'VOTE-';

module.exports = function registerVoting(app, { db, admin }) {
    const FieldValue = admin.firestore.FieldValue;
    const pollsCol = db.collection('polls');
    const votePaymentsCol = db.collection('vote_payments');

    // ── Helpers ──────────────────────────────────────────────────────────────
    const validPhone = (p) => /^(07|01|254)\d{8,9}$/.test(String(p || '').replace('+', ''));
    const isOpen = (poll) => Date.now() < poll.closesAt;

    function requireAdmin(req, res) {
        const expected = process.env.ADMIN_KEY || '';
        const given = String(req.headers['x-admin-key'] || '');
        const ok = expected.length > 0 && given.length === expected.length &&
            crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
        if (!ok) {
            res.status(401).json({ error: 'Admin key required.' });
            return false;
        }
        return true;
    }

    function publicPoll(id, poll) {
        return {
            id,
            title: poll.title,
            description: poll.description || '',
            options: poll.options.map(o => ({
                id: o.id, name: o.name, position: o.position || '', county: o.county || ''
            })),
            votePriceKES: VOTE_PRICE_KES,
            closesAt: poll.closesAt,
            open: isOpen(poll)
        };
    }

    // Sends the KSh 15 STK push through Lipwa (same endpoint the deposit flow uses).
    async function startStk(ref, phone_number) {
        const LIPWA_KEY = process.env.LIPWA_API_KEY;
        const LIPWA_CHANNEL = process.env.LIPWA_CHANNEL_ID;
        const CALLBACK_URL = process.env.CALLBACK_URL;
        if (!LIPWA_KEY || !LIPWA_CHANNEL || !CALLBACK_URL) {
            return { ok: false, error: 'Payment service not configured.' };
        }
        try {
            const r = await fetch(`${LIPWA_BASE}/payments`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${LIPWA_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: VOTE_PRICE_KES,
                    callback_url: CALLBACK_URL,
                    channel_id: LIPWA_CHANNEL,
                    phone_number,
                    api_ref: ref
                })
            });
            const data = await r.json();
            if (r.status === 201 && data.ResponseCode === '0') {
                return {
                    ok: true,
                    checkoutRequestId: data.CheckoutRequestID,
                    message: data.CustomerMessage || 'Check your phone and enter your M-Pesa PIN.'
                };
            }
            return { ok: false, error: data.ResponseDescription || data.message || 'Payment request failed.' };
        } catch (err) {
            console.error('Vote STK error:', err);
            return { ok: false, error: 'Could not reach payment provider. Try again.' };
        }
    }

    // Asks Lipwa for the status of a payment. Returns null if it cannot be reached.
    async function lipwaStatus(key) {
        try {
            const r = await fetch(`${LIPWA_BASE}/status?ref=${encodeURIComponent(key)}`, {
                headers: { 'Authorization': `Bearer ${process.env.LIPWA_API_KEY}` }
            });
            return await r.json();
        } catch (err) {
            return null;
        }
    }

    // Marks a pending payment as paid and adds one vote. Runs in a transaction, so
    // a callback and a status check arriving together cannot count the vote twice.
    async function confirmVote(ref, receipt) {
        const payRef = votePaymentsCol.doc(ref);
        return db.runTransaction(async (t) => {
            const snap = await t.get(payRef);
            if (!snap.exists) return 'unknown';
            const pay = snap.data();
            if (pay.status !== 'pending') return pay.status;
            t.update(payRef, { status: 'paid', receipt: receipt || null, confirmedAt: Date.now() });
            t.update(pollsCol.doc(pay.pollId), { [`tally.${pay.optionId}`]: FieldValue.increment(1) });
            return 'paid';
        });
    }

    async function markFailed(ref, reason) {
        const payRef = votePaymentsCol.doc(ref);
        return db.runTransaction(async (t) => {
            const snap = await t.get(payRef);
            if (!snap.exists || snap.data().status !== 'pending') return;
            t.update(payRef, { status: 'failed', reason: String(reason || '') });
        });
    }

    // ── Admin: create and list polls ─────────────────────────────────────────
    app.post('/api/admin/polls', async (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const { title, description, options, closesAt } = req.body || {};
            if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
            if (!Array.isArray(options) || options.length < 2 || options.length > 20) {
                return res.status(400).json({ error: 'Add between 2 and 20 options.' });
            }
            const cleanOptions = options.map((o, i) => ({
                id: i + 1,
                name: String((o && o.name) || '').trim(),
                position: String((o && o.position) || '').trim(),
                county: String((o && o.county) || '').trim()
            }));
            if (cleanOptions.some(o => !o.name)) return res.status(400).json({ error: 'Every option needs a name.' });

            let closeMs = DEFAULT_CLOSES_AT;
            if (closesAt) {
                closeMs = Date.parse(closesAt);
                if (isNaN(closeMs)) return res.status(400).json({ error: 'Invalid closing date.' });
            }

            const tally = {};
            cleanOptions.forEach(o => { tally[o.id] = 0; });
            const id = crypto.randomBytes(8).toString('hex');
            await pollsCol.doc(id).set({
                title: String(title).trim(),
                description: String(description || '').trim(),
                options: cleanOptions,
                tally,
                closesAt: closeMs,
                createdAt: Date.now()
            });
            res.json({ success: true, id });
        } catch (err) {
            console.error('Create poll error:', err);
            res.status(500).json({ error: 'Could not create poll.' });
        }
    });

    app.get('/api/admin/polls', async (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const snap = await pollsCol.orderBy('createdAt', 'desc').get();
            res.json({
                polls: snap.docs.map(d => {
                    const p = d.data();
                    const tally = p.tally || {};
                    return {
                        id: d.id,
                        title: p.title,
                        closesAt: p.closesAt,
                        open: isOpen(p),
                        options: p.options,
                        tally,
                        totalVotes: Object.values(tally).reduce((a, b) => a + b, 0)
                    };
                })
            });
        } catch (err) {
            console.error('List polls error:', err);
            res.status(500).json({ error: 'Could not load polls.' });
        }
    });

    // ── Public: view a poll, vote, check payment, see results ────────────────
    app.get('/api/polls/:id', async (req, res) => {
        try {
            const snap = await pollsCol.doc(req.params.id).get();
            if (!snap.exists) return res.status(404).json({ error: 'Poll not found.' });
            res.json(publicPoll(snap.id, snap.data()));
        } catch (err) {
            res.status(500).json({ error: 'Could not load poll.' });
        }
    });

    app.post('/api/polls/:id/vote', async (req, res) => {
        try {
            const { optionId, phone_number } = req.body || {};
            if (!validPhone(phone_number)) {
                return res.status(400).json({ error: 'Enter a valid M-Pesa number (e.g. 0712345678).' });
            }
            const snap = await pollsCol.doc(req.params.id).get();
            if (!snap.exists) return res.status(404).json({ error: 'Poll not found.' });
            const poll = snap.data();
            if (!isOpen(poll)) return res.status(403).json({ error: 'Voting has closed.' });
            const option = poll.options.find(o => String(o.id) === String(optionId));
            if (!option) return res.status(400).json({ error: 'Choose a valid option.' });

            const ref = REF_PREFIX + crypto.randomBytes(10).toString('hex');
            await votePaymentsCol.doc(ref).set({
                pollId: req.params.id,
                optionId: option.id,
                phone: phone_number,
                amount: VOTE_PRICE_KES,
                status: 'pending',
                createdAt: Date.now()
            });

            const stk = await startStk(ref, phone_number);
            if (!stk.ok) {
                await markFailed(ref, stk.error);
                return res.status(400).json({ error: stk.error });
            }
            await votePaymentsCol.doc(ref).update({ checkoutRequestId: stk.checkoutRequestId });
            res.json({ success: true, ref, message: stk.message });
        } catch (err) {
            console.error('Vote error:', err);
            res.status(500).json({ error: 'Could not start payment. Try again.' });
        }
    });

    app.get('/api/polls/:id/payment/:ref', async (req, res) => {
        try {
            const payRef = votePaymentsCol.doc(req.params.ref);
            const snap = await payRef.get();
            if (!snap.exists || snap.data().pollId !== req.params.id) {
                return res.status(404).json({ error: 'Payment not found.' });
            }
            let pay = snap.data();
            if (pay.status === 'pending') {
                const data = await lipwaStatus(pay.checkoutRequestId || req.params.ref);
                const s = String((data && data.status) || '').toLowerCase();
                if (s.includes('success') || s === 'completed') {
                    await confirmVote(req.params.ref, data.receipt);
                } else if (s.includes('fail') || s.includes('cancel')) {
                    await markFailed(req.params.ref, s);
                }
                pay = (await payRef.get()).data();
            }
            res.json({ status: pay.status });
        } catch (err) {
            console.error('Payment check error:', err);
            res.status(500).json({ error: 'Could not check payment.' });
        }
    });

    app.get('/api/polls/:id/results', async (req, res) => {
        try {
            const snap = await pollsCol.doc(req.params.id).get();
            if (!snap.exists) return res.status(404).json({ error: 'Poll not found.' });
            const poll = snap.data();
            if (isOpen(poll)) {
                return res.status(403).json({ error: 'Results are hidden until voting closes.', closesAt: poll.closesAt });
            }
            const tally = poll.tally || {};
            res.json({
                title: poll.title,
                results: poll.options.map(o => ({ id: o.id, name: o.name, votes: tally[o.id] || 0 }))
            });
        } catch (err) {
            res.status(500).json({ error: 'Could not load results.' });
        }
    });

    // ── Lipwa callback hook ──────────────────────────────────────────────────
    // server.js calls this first; returns true if the payload was a vote payment.
    async function handleCallback(payload) {
        const ref = payload && payload.api_ref;
        if (!ref || !String(ref).startsWith(REF_PREFIX)) return false;
        const s = String(payload.status || '').toLowerCase();
        if (s.includes('success') || s === 'completed') {
            await confirmVote(ref, payload.mpesa_code);
        } else if (s.includes('fail') || s.includes('cancel')) {
            await markFailed(ref, s);
        }
        return true;
    }

    return { handleCallback };
};
