-- Medio de pago "Cuenta corriente" (fiado / cuenta de empresa). Va en su propia migración:
-- un valor nuevo de enum no se puede usar en la misma transacción que lo crea.
alter type public.payment_kind add value if not exists 'account';
