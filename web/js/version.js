/**
 * What version this is, in one place.
 *
 * It matters more here than in most web apps. The page is cached by a service worker and launched
 * from a home-screen icon, so what runs at the car can be older than what is on GitHub — and the
 * symptom of that is a bug you already fixed, reported again. The number shown in the footer comes
 * out of this file, which is cached together with everything else, so it names the bundle actually
 * running rather than the newest one that exists.
 *
 * It also goes into the shared log and the downloaded report, so an issue says which version
 * produced it without anyone having to ask.
 *
 * **`sw.js` carries this number too**, in its cache name, and cannot import it: a classic service
 * worker has no ES modules. `report.test.mjs` asserts the two agree, because the failure mode of
 * forgetting is silent — the cache keeps its old name and nobody gets the update.
 */
export const VERSION = '0.80';
