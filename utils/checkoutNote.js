/**
 * Checkout "accomplishment" note must be substantive (not only spaces/punctuation).
 * Allows Latin and Arabic letters and digits; requires enough real characters.
 */
const normalizeForLetterCount = (s) =>
    String(s || '')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .trim();

const isSubstantiveCheckoutNote = (raw) => {
    const trimmed = String(raw || '').trim();
    if (trimmed.length < 8) return false;
    const lettersOrDigits = normalizeForLetterCount(trimmed);
    if (lettersOrDigits.length < 5) return false;
    return true;
};

const validateCheckoutAccomplishmentNote = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
        return {
            ok: false,
            message:
                'Check-out note is required. Briefly describe what you accomplished today (at least a few words).'
        };
    }
    if (!isSubstantiveCheckoutNote(trimmed)) {
        return {
            ok: false,
            message:
                'Check-out note is too short or not meaningful. Use a short sentence describing your work (not only symbols or spaces).'
        };
    }
    return { ok: true, value: trimmed.slice(0, 4000) };
};

module.exports = {
    isSubstantiveCheckoutNote,
    validateCheckoutAccomplishmentNote
};
