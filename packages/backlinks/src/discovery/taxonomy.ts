/**
 * Industry and geography vocabulary used for industry-aware and country-aware discovery and scoring.
 * Nothing here is tied to a single industry or website; add industries by extending INDUSTRIES.
 */

export interface IndustryDef {
  key: string;
  label: string;
  terms: string[];
  /** Typical opportunity categories worth pursuing for this industry. */
  categories: string[];
}

export const INDUSTRIES: IndustryDef[] = [
  {
    key: "healthcare",
    label: "Healthcare",
    terms: [
      "health",
      "healthcare",
      "clinic",
      "hospital",
      "doctor",
      "physician",
      "dental",
      "dentist",
      "medical",
      "patient",
      "therapy",
      "pharmacy",
      "wellness",
      "nursing",
      "diagnostic"
    ],
    categories: ["business_listing", "industry_directory", "association", "resource_page", "review_platform"]
  },
  {
    key: "education",
    label: "Education",
    terms: [
      "education",
      "school",
      "college",
      "university",
      "course",
      "courses",
      "training",
      "learning",
      "tutor",
      "tutoring",
      "academy",
      "students",
      "curriculum",
      "edtech"
    ],
    categories: ["industry_directory", "resource_page", "association", "guest_post", "business_listing"]
  },
  {
    key: "ecommerce",
    label: "Ecommerce",
    terms: ["ecommerce", "e-commerce", "online store", "shop", "shopping", "retail", "products", "marketplace", "buy online", "brand", "d2c", "dtc"],
    categories: ["review_platform", "business_listing", "guest_post", "resource_page", "partner"]
  },
  {
    key: "technology",
    label: "Technology / SaaS",
    terms: [
      "software",
      "saas",
      "technology",
      "tech",
      "app",
      "cloud",
      "platform",
      "developer",
      "api",
      "startup",
      "ai",
      "automation",
      "it services",
      "digital"
    ],
    categories: ["startup_directory", "review_platform", "guest_post", "resource_page", "industry_directory"]
  },
  {
    key: "manufacturing",
    label: "Manufacturing / Industrial",
    terms: [
      "manufacturing",
      "manufacturer",
      "industrial",
      "factory",
      "supplier",
      "b2b",
      "engineering",
      "machinery",
      "components",
      "forging",
      "casting",
      "fabrication",
      "oem",
      "textile",
      "polymer"
    ],
    categories: ["industry_directory", "business_listing", "association", "partner"]
  },
  {
    key: "hospitality",
    label: "Hospitality / Travel / Food",
    terms: ["hotel", "resort", "restaurant", "travel", "tourism", "hospitality", "cafe", "dining", "stay", "booking", "food", "catering", "events"],
    categories: ["business_listing", "review_platform", "industry_directory", "resource_page"]
  },
  {
    key: "finance",
    label: "Finance",
    terms: [
      "finance",
      "financial",
      "bank",
      "banking",
      "insurance",
      "investment",
      "wealth",
      "accounting",
      "tax",
      "loan",
      "fintech",
      "payments",
      "advisor",
      "forex"
    ],
    categories: ["industry_directory", "association", "resource_page", "business_listing"]
  },
  {
    key: "professional_services",
    label: "Professional services",
    terms: [
      "consulting",
      "consultant",
      "agency",
      "law",
      "legal",
      "lawyer",
      "accountant",
      "marketing",
      "advertising",
      "design",
      "architecture",
      "recruitment",
      "hr",
      "services"
    ],
    categories: ["agency_directory", "business_listing", "association", "review_platform", "guest_post"]
  },
  {
    key: "marketing_agency",
    label: "Digital marketing agency",
    terms: [
      "digital marketing",
      "seo",
      "social media",
      "performance marketing",
      "ppc",
      "branding",
      "content marketing",
      "agency",
      "advertising",
      "creative",
      "web design",
      "campaigns"
    ],
    categories: ["agency_directory", "review_platform", "guest_post", "resource_page", "business_listing"]
  },
  {
    key: "real_estate",
    label: "Real estate",
    terms: [
      "real estate",
      "property",
      "properties",
      "realty",
      "homes",
      "apartments",
      "plots",
      "housing",
      "builder",
      "developer",
      "broker",
      "realtor",
      "rent",
      "commercial space"
    ],
    categories: ["industry_directory", "business_listing", "association", "review_platform"]
  },
  {
    key: "nonprofit",
    label: "Non-profit / Social impact",
    terms: ["nonprofit", "non-profit", "ngo", "charity", "foundation", "donate", "volunteer", "social impact", "csr", "community"],
    categories: ["association", "resource_page", "industry_directory", "partner"]
  },
  {
    key: "other",
    label: "Other",
    terms: ["business", "company", "services", "local"],
    categories: ["business_listing", "resource_page", "industry_directory"]
  }
];

export function industryDef(key: string): IndustryDef {
  return INDUSTRIES.find((i) => i.key === key) ?? INDUSTRIES[INDUSTRIES.length - 1]!;
}

export const COUNTRIES: Record<string, { name: string; terms: string[]; lang: string[] }> = {
  IN: {
    name: "India",
    terms: ["india", "indian", "mumbai", "delhi", "bengaluru", "bangalore", "pune", "hyderabad", "chennai", "kolkata", "ahmedabad", "+91"],
    lang: ["en-in", "hi"]
  },
  US: { name: "United States", terms: ["united states", "usa", "u.s.", "america", "new york", "california", "texas", "florida"], lang: ["en-us"] },
  GB: { name: "United Kingdom", terms: ["united kingdom", "uk", "britain", "england", "london", "scotland", "wales", "manchester"], lang: ["en-gb"] },
  CA: { name: "Canada", terms: ["canada", "canadian", "toronto", "vancouver", "montreal", "ontario"], lang: ["en-ca", "fr-ca"] },
  AU: { name: "Australia", terms: ["australia", "australian", "sydney", "melbourne", "brisbane", "perth"], lang: ["en-au"] },
  AE: { name: "United Arab Emirates", terms: ["uae", "united arab emirates", "dubai", "abu dhabi", "sharjah"], lang: ["ar-ae", "en-ae"] },
  SG: { name: "Singapore", terms: ["singapore"], lang: ["en-sg"] },
  DE: { name: "Germany", terms: ["germany", "deutschland", "berlin", "munich", "hamburg"], lang: ["de", "de-de"] },
  FR: { name: "France", terms: ["france", "paris", "lyon", "marseille"], lang: ["fr", "fr-fr"] },
  NZ: { name: "New Zealand", terms: ["new zealand", "auckland", "wellington"], lang: ["en-nz"] },
  IE: { name: "Ireland", terms: ["ireland", "dublin", "cork"], lang: ["en-ie"] },
  ZA: { name: "South Africa", terms: ["south africa", "johannesburg", "cape town", "durban"], lang: ["en-za"] }
};

export function countryName(code: string): string {
  return COUNTRIES[code]?.name ?? code;
}
