import { ConvexError } from "convex/values";
import type { PlaceRecord } from "./places";

/**
 * THE GOOGLE CALL, AND WHAT WE ASK IT FOR.
 *
 * Places API (New) Text Search. Kept apart from the action that orchestrates
 * a run so the MAPPING can be tested without a network — the part that goes
 * wrong is not the fetch, it is deciding that a field which is sometimes
 * absent is always present.
 *
 * WE DO NOT ASK FOR RATINGS, and that is a decision rather than an omission.
 * `rating` and `userRatingCount` are Google Maps Content on a 30-day clock,
 * a guard already keeps them out of every table but `placesCache`, and a lead
 * has no use for one — `leads.rating` existed once and was removed precisely
 * because it was a permanent copy of temporary content. Not requesting them
 * means we never hold them at all, which is a stronger position than holding
 * them correctly. It is also cheaper: the field mask decides the SKU, and
 * ratings move the request into a dearer one.
 *
 * THE FIELD MASK IS THE BILL. Places API (New) charges by which fields you
 * ask for, so this list is a cost decision as much as a data one. Every field
 * here earns its place: an id to dedupe on, a name and address to know who
 * they are, a phone to call, a website to judge whether they need one, and
 * the attributions the terms require us to carry.
 */

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

/**
 * Asked for by name, so adding one is a visible change to what we pay and
 * what we hold rather than a quiet edit inside a request body.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.attributions",
  "nextPageToken",
].join(",");

export type PlacesPage = {
  places: PlaceRecord[];
  nextPageToken: string | null;
};

/** Shapes we actually read. Everything else in the response is ignored. */
type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  attributions?: Array<{ provider?: string; providerUri?: string }>;
};

/**
 * One response into records.
 *
 * DEFENSIVE ABOUT ABSENCE, because most of these fields are optional in the
 * API and a business with no website is the normal case rather than an error
 * — it is, in fact, the case we are looking for. A record with no `id` is
 * dropped: the id is the dedupe key and the one field we may keep
 * indefinitely, so a place without one is not usable as a lead.
 */
export function mapPlacesResponse(body: unknown): PlacesPage {
  const raw = (body ?? {}) as { places?: RawPlace[]; nextPageToken?: string };
  const places: PlaceRecord[] = [];

  for (const place of raw.places ?? []) {
    if (!place.id) continue;

    places.push({
      placeId: place.id,
      displayName: place.displayName?.text || undefined,
      formattedAddress: place.formattedAddress || undefined,
      phone: place.nationalPhoneNumber || undefined,
      website: place.websiteUri || undefined,
      googleMapsUri: place.googleMapsUri || undefined,
      /*
       * Carried through even when empty. The terms require attributions to
       * accompany anything displayed, and `writePlace` refuses to store a
       * record that lost them between fetch and write — an empty array is a
       * response that had none, which is different from having dropped them.
       */
      attributionHtml: (place.attributions ?? [])
        .map((a) => a.provider)
        .filter((p): p is string => Boolean(p)),
    });
  }

  return { places, nextPageToken: raw.nextPageToken || null };
}

/**
 * Fetch one page.
 *
 * The caller has ALREADY been charged for this call — `reserveSpend` runs in
 * its own transaction before this is reached, and there is no refund path if
 * this throws. That ordering is the whole point of the ledger: over-counting
 * refuses a call we could have afforded, under-counting spends past the cap.
 */
export async function searchPlaces(input: {
  apiKey: string;
  textQuery: string;
  pageToken?: string;
  /** Places API (New) caps a page at 20. */
  pageSize?: number;
  regionCode?: string;
}): Promise<PlacesPage> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": input.apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: input.textQuery,
      maxResultCount: Math.min(input.pageSize ?? 20, 20),
      regionCode: input.regionCode ?? "ZA",
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    }),
  });

  if (!response.ok) {
    /*
     * The body is read for its message and NOT logged wholesale: a Places
     * error echoes the request, and the request carries the API key header's
     * effects if not the key itself. The status and Google's own message are
     * what a person needs.
     */
    const detail = await response.text().catch(() => "");
    const message =
      (() => {
        try {
          return (JSON.parse(detail) as { error?: { message?: string } })?.error?.message;
        } catch {
          return undefined;
        }
      })() ?? `HTTP ${response.status}`;

    throw new ConvexError({
      code: "PLACES_REQUEST_FAILED",
      message: `Google Places refused the search: ${message}`,
    });
  }

  return mapPlacesResponse(await response.json());
}
