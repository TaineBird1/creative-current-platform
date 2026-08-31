import type { SiteConfig } from "../site-config";
import { SITE_CONFIG_VERSION } from "../site-config";

/**
 * TEMPLATE #1 -- solar / trades.
 *
 * Seeded from a real, shipped solar site (Renu Solar, KZN): real copy, real
 * structure, real numbers with their sources attached. It exists to make the
 * section registry earn its keep against content nobody invented for it.
 *
 * Two things it deliberately does NOT do:
 *   - no booking flow. A solar job is quoted, not booked into a slot. The
 *     quote section is the conversion surface. Guest houses become template #2
 *     when a direct-booking client lands, and that is when `booking` gets
 *     exercised for real.
 *   - no reviews section and no gallery. Both require assets we do not have
 *     for a given client at seed time, and the registry refuses stock imagery
 *     in a work gallery. They get added per client, with consent, or not at all.
 *
 * Every number in this file carries a `source`. That is not politeness -- the
 * statBand schema requires it, because a number without a source is a claim.
 */

type SeedInput = {
  businessName: string;
  slug: string;
  brandColour: string;
  accent: SiteConfig["brand"]["accent"];
  city: string;
  region: string;
  suburb: string;
  addressLine: string;
  phone: string;
  whatsapp?: string;
  email?: string;
  timezone?: string;
  /**
   * Skin within the template. `ink` (editorial, alternating bands) or
   * `field-manual` (one ground, ruled, mono for measurement). Both render the
   * same sections from the same registry — a variant is a stylesheet, never a
   * second component tree. Demos rotate it so two leads never see the same
   * site. Defaults to `ink`.
   */
  variant?: "ink" | "field-manual";
};

export function solarTradesTemplate(input: SeedInput): SiteConfig {
  const timezone = input.timezone ?? "Africa/Johannesburg";

  return {
    version: SITE_CONFIG_VERSION,
    template: "solar-trades",
    variant: input.variant ?? "ink",
    currency: "ZAR",
    defaultTimezone: timezone,

    brand: {
      name: input.businessName,
      colour: input.brandColour,
      accent: input.accent,
      typeScale: "regular",
      fontPair: "instrument-inter",
    },

    locations: [
      {
        id: "main",
        name: input.businessName,
        addressLine: input.addressLine,
        suburb: input.suburb,
        city: input.city,
        region: input.region,
        countryCode: "ZA",
        phone: input.phone,
        whatsapp: input.whatsapp,
        email: input.email,
        timezone,
        hours: [
          { day: 1, open: "08:00", close: "17:00" },
          { day: 2, open: "08:00", close: "17:00" },
          { day: 3, open: "08:00", close: "17:00" },
          { day: 4, open: "08:00", close: "17:00" },
          { day: 5, open: "08:00", close: "16:00" },
        ],
      },
    ],

    seo: {
      title: `${input.businessName} | Solar PV & battery storage in ${input.region}`,
      description: `${input.businessName} designs, installs and maintains solar PV and battery systems across ${input.region}, with in-house engineering teams and a contractual fault-correction SLA.`,
      noindex: false,
    },

    features: {
      booking: false,
      quotes: true,
      gallery: false,
      reviews: false,
      stock: false,
      analytics: { consentGated: true },
    },

    legal: {},

    sections: [
      {
        id: "hero",
        type: "hero",
        variant: "editorial",
        hidden: false,
        headline: "Power costs more every single year. Sunlight doesn't.",
        subhead:
          "Solar PV and battery storage, designed against your actual bill rather than a catalogue tier, installed by the people who designed it.",
        primaryCta: { label: "Get a quote", action: "quote" },
        secondaryCta: { label: "WhatsApp us", action: "whatsapp" },
        trustLine: "In-house engineering teams. No subcontractors.",
      },

      {
        id: "tariff",
        type: "statBand",
        variant: "default",
        hidden: false,
        stats: [
          {
            value: "R4.17/kWh",
            label: "eThekwini residential tariff, incl. VAT",
            source: "eThekwini Municipality tariff schedule",
            asAt: "1 July 2026",
          },
          {
            value: "+8.83%",
            label: "Eskom increase already approved",
            source: "NERSA determination",
            asAt: "April 2027",
          },
        ],
      },

      {
        id: "argument",
        type: "narrative",
        variant: "default",
        hidden: false,
        tone: "paper",
        eyebrow: "The 2026 argument",
        heading: "This was never about the dark.",
        body: [
          "South Africa has had no national load shedding since May 2025, and the old “never sit in the dark again” pitch went with it.",
          "What replaced it is simpler and harder to argue with: every kilowatt-hour you consume yourself is one you do not buy at the municipal rate, and that rate compounds every single year.",
          "The design question is therefore not how big a system you can afford. It is how much of your own consumption you can move into the hours the sun is already up.",
        ],
        pullQuote: "Exported units are worth far less than the ones you use yourself.",
      },

      {
        id: "how",
        type: "process",
        variant: "numbered",
        hidden: false,
        eyebrow: "From sun to socket",
        heading: "Six steps, and you know who owns each one.",
        steps: [
          {
            title: "Sunlight arrives, whether you use it or not",
            body:
              "KwaZulu-Natal gets 5.0–5.4 peak sun hours a day, and the curve is far flatter across the seasons than the Cape's. Winter yield does not fall off a cliff.",
            marker: "01",
          },
          {
            title: "Modules turn it into DC",
            body:
              "Array size follows your actual consumption profile, not a catalogue tier. Orientation and shading are modelled from the roof we measured.",
            marker: "02",
          },
          {
            title: "The inverter decides where every watt goes",
            body:
              "It arbitrates in real time between your load, the battery and the grid. It must carry NRS 097-2-1:2024 certification to be registered.",
            marker: "03",
          },
          {
            title: "Storage moves midday surplus into the evening",
            body:
              "Typically 25–40% of system cost, so it is sized against your evening load rather than sold by the kilowatt-hour.",
            marker: "04",
          },
          {
            title: "Self-consumption is where the money actually is",
            body:
              "Every kilowatt-hour you consume yourself is one you do not buy at the municipal rate. Exported units are worth far less.",
            marker: "05",
          },
          {
            title: "Registration, then commissioning",
            body:
              "SSEG registration is required for any grid-interactive inverter, even with export set to zero. We handle the submission.",
            marker: "06",
          },
        ],
      },

      {
        id: "sectors",
        type: "cards",
        variant: "bordered",
        hidden: false,
        columns: 4,
        eyebrow: "Four sectors",
        heading: "One engineering standard, four very different jobs.",
        intro:
          "A 5 kW home hybrid and a three-phase packhouse share almost nothing except the people who install them.",
        items: [
          {
            title: "Homes",
            body:
              "Hybrid PV and storage sized against your actual bill, with the geyser and pool moved into the solar window before a single extra panel is quoted.",
          },
          {
            title: "Commercial",
            body:
              "Offices, retail and hospitality, where the load profile is daytime-heavy and the Section 12B deduction changes the arithmetic completely.",
          },
          {
            title: "Industrial",
            body:
              "Three-phase plant where downtime is the real cost. Designed around process continuity, power quality and the hard limits of your existing supply.",
          },
          {
            title: "Agricultural",
            body:
              "Irrigation, cold chain and packhouses — loads that are seasonal, pump-heavy and often at the end of a long, weak rural feed.",
          },
        ],
      },

      {
        id: "equipment",
        type: "logoStrip",
        variant: "default",
        hidden: false,
        eyebrow: "Equipment we install and support",
        logos: [
          { name: "Sunsynk" },
          { name: "Deye" },
          { name: "Victron" },
          { name: "Freedom Won" },
          { name: "JA Solar" },
          { name: "Canadian Solar" },
        ],
        disclaimer:
          "We are not tied to a single manufacturer. Specification follows the site, the load profile and the warranty terms — not a distributor target.",
      },

      {
        id: "coastal",
        type: "narrative",
        variant: "default",
        hidden: false,
        tone: "dark",
        eyebrow: "Coastal-specific",
        heading: "Salt air is what kills solar in this city.",
        body: [
          "Within a kilometre of the shore, premature failure is almost never a panel problem. It is the mounting, the fixings, the conduit and the connectors.",
          "Stainless grade, cable gland choice and DC isolator placement matter more here than the brand on the module, and they are the first things a cheap quote leaves out.",
        ],
      },

      {
        id: "sla",
        type: "cards",
        variant: "promise",
        hidden: false,
        columns: 4,
        eyebrow: "What we sign up to",
        heading: "The promises that are contractual.",
        intro:
          "Plenty of installers say they will look after you. These four are written into the agreement, which means you can hold us to them.",
        items: [
          {
            title: "Named project manager",
            body:
              "One person owns your job from survey to commissioning, and you have their number. Not a rotating call-centre queue.",
          },
          {
            title: "24-month workmanship warranty",
            body:
              "Twenty-four months on our labour and installation, entirely separate from the manufacturer warranties on panels, inverter and battery.",
          },
          {
            title: "72-hour fault correction",
            body:
              "A contractual 72-hour window to correct a reported fault under SLA — a deadline, not an aspiration.",
          },
          {
            title: "No subcontractors",
            body:
              "Engineering and installation are both in-house. The team that designed it is the team that installs it and comes back.",
          },
        ],
      },

      {
        id: "faq",
        type: "faq",
        variant: "default",
        hidden: false,
        heading: "The five questions everyone asks first.",
        items: [
          {
            q: "Is there still a solar tax rebate for my house?",
            a: "No. The Section 6C residential rebate expired on 29 February 2024 and there is currently no residential solar tax incentive in South Africa. Businesses are a different story — Section 12B still applies.",
          },
          {
            q: "Do I have to register if I never export anything?",
            a: "Yes. If the inverter is grid-interactive, SSEG registration is required even with export set to zero. It is about what is electrically connected to the municipal network, not what you send back. Non-compliance can void your insurance.",
          },
          {
            q: "What does a system actually cost?",
            a: "Installed bands: 3 kWp R45–70k; 5 kWp with 5–10 kWh storage R80–120k; 8 kWp R115–180k; 10 kWp with 15 kWh R235–285k. Three-phase adds R15–30k. The battery alone is usually 25–40% of the total.",
          },
          {
            q: "Load shedding is over. Why bother now?",
            a: "Because the case was never really about outages. Municipal tariffs rise every year and compound; every unit you self-consume is one you never buy.",
          },
          {
            q: "How long does the whole thing take?",
            a: "The installation itself is typically two to five days. Municipal SSEG approval is the long pole. Realistically, plan for four to eight weeks from signature to a commissioned, registered system.",
          },
        ],
      },

      {
        id: "quote",
        type: "quote",
        variant: "stepped",
        hidden: false,
        heading: "Start with the number, not the sales call.",
        fields: [
          {
            key: "propertyType",
            label: "What are we quoting?",
            kind: "select",
            required: true,
            options: ["Home", "Commercial premises", "Industrial plant", "Farm / agricultural"],
          },
          {
            key: "monthlyBill",
            label: "Roughly what is your monthly electricity bill?",
            kind: "select",
            required: true,
            options: ["Under R1,500", "R1,500–R3,000", "R3,000–R6,000", "R6,000–R12,000", "Over R12,000"],
          },
          {
            key: "phase",
            label: "Single-phase or three-phase supply?",
            kind: "select",
            required: false,
            options: ["Single-phase", "Three-phase", "Not sure"],
          },
          {
            key: "goal",
            label: "What matters most to you?",
            kind: "select",
            required: false,
            options: ["Cutting the bill", "Backup during outages", "Both, in that order"],
          },
          {
            key: "notes",
            label: "Anything else we should know?",
            kind: "longtext",
            required: false,
          },
          {
            key: "photos",
            label: "Photos of the roof or DB board, if you have them",
            kind: "photos",
            required: false,
          },
        ],
        photoUpload: { enabled: true, maxFiles: 5 },
        consentText:
          "I agree that my details may be used to contact me about this enquiry. I can ask for them to be deleted at any time.",
        submitLabel: "Request a quote",
        successMessage:
          "Got it. We will call you back on the number you gave us, usually the same working day.",
      },

      {
        id: "contact",
        type: "contact",
        variant: "default",
        hidden: false,
        heading: "Or just phone us.",
        showMap: true,
        consent: {
          required: true,
          text: "I agree that my details may be used to respond to this message.",
          lawfulBasis: "consent",
        },
      },

      {
        id: "sticky",
        type: "stickyBar",
        variant: "default",
        hidden: false,
        actions: ["quote", "call", "whatsapp"],
        phone: input.phone,
        whatsapp: input.whatsapp ?? input.phone,
      },
    ],
  };
}
