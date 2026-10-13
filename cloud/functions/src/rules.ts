/**
 * Merchant rules, generated from spendtrack/rules.toml - the single source of
 * truth that the Python app also reads. Regenerate rather than edit by hand.
 *
 * Order matters: the first category whose alternation matches wins, which is
 * why Transfer sits ahead of everything (a card autopay also carries the
 * bank name) and Health ahead of Shopping (MACY lives inside PHARMACY).
 */

export const CATEGORIES = ["Groceries", "Restaurants", "Coffee", "Transport", "Fuel", "Travel", "Shopping", "Subscriptions", "Utilities", "Rent", "Health", "Fitness", "Entertainment", "Education", "Personal Care", "Fees", "Income", "Transfer", "Other"] as const;

export type Category = (typeof CATEGORIES)[number];

/** One compiled alternation per category, in priority order. */
export const RULES: ReadonlyArray<readonly [Category, RegExp]> = [
  ["Transfer", /(?:PAYMENT THANK YOU)|(?:AUTOPAY)|(?:ONLINE PAYMENT)|(?:CARD PAYMENT)|(?:ZELLE)|(?:VENMO)|(?:CASH ?APP)|(?:PAYPAL TRANSFER)|(?:WIRE TRANSFER)|(?:TRANSFER TO)|(?:TRANSFER FROM)|(?:ACH (DEBIT|CREDIT))|(?:BILL ?PAY)|(?:E[- ]?PAYMENT)|(?:\bPYMT\b)|(?:\bDEPOSIT\b)|(?:CREDIT CRD)|(?:EPAY\b)/i],
  ["Income", /(?:PAYROLL)|(?:DIRECT ?DEP)|(?:DIR DEP)|(?:\bSALARY\b)|(?:IRS TREAS)|(?:TAX REF)|(?:INTEREST PAID)|(?:CASHBACK BONUS)|(?:\bREWARD)/i],
  ["Groceries", /(?:TRADER JOE)|(?:WHOLE FOODS)|(?:SAFEWAY)|(?:KROGER)|(?:\bALDI\b)|(?:COSTCO)|(?:WEGMANS)|(?:STOP & ?SHOP)|(?:STAR MARKET)|(?:\bH MART\b)|(?:PATEL BROTHERS)|(?:INSTACART)|(?:SPROUTS)|(?:PUBLIX)|(?:MARKET BASKET)/i],
  ["Coffee", /(?:STARBUCKS)|(?:DUNKIN)|(?:BLUE BOTTLE)|(?:\bPEET)|(?:\bCAFE\b)|(?:COFFEE)/i],
  ["Restaurants", /(?:CHIPOTLE)|(?:MCDONALD)|(?:SHAKE SHACK)|(?:DOORDASH)|(?:UBER ?EATS)|(?:GRUBHUB)|(?:SWEETGREEN)|(?:PANERA)|(?:\bTST\b)|(?:\bCAVA\b)|(?:HALAL GUYS)|(?:DOMINO)|(?:PIZZA)|(?:RESTAURANT)|(?:\bGRILL\b)|(?:\bKITCHEN\b)|(?:\bTAQUERIA\b)/i],
  ["Transport", /(?:UBER(?! ?EATS))|(?:\bLYFT\b)|(?:\bMBTA\b)|(?:\bMTA\b)|(?:\bBART\b)|(?:TRANSIT)|(?:AMTRAK)|(?:ZIPCAR)|(?:PARKING)|(?:SPOTHERO)|(?:SUBWAY STATION)|(?:\bCLIPPER\b)/i],
  ["Fuel", /(?:\bSHELL\b)|(?:EXXON)|(?:CHEVRON)|(?:\bBP\b)|(?:SUNOCO)|(?:\bMOBIL\b)|(?:\bGULF\b)|(?:CITGO)|(?:SPEEDWAY)/i],
  ["Travel", /(?:AIRLINES)|(?:AIRWAYS)|(?:DELTA AIR)|(?:UNITED AIR)|(?:JETBLUE)|(?:SOUTHWEST AIR)|(?:AIRBNB)|(?:BOOKING\.COM)|(?:EXPEDIA)|(?:\bHOTEL)|(?:MARRIOTT)|(?:HILTON)|(?:\bHYATT\b)|(?:CAR RENTAL)|(?:\bHERTZ\b)/i],
  ["Subscriptions", /(?:OURARING)|(?:OURA RING)|(?:NETFLIX)|(?:SPOTIFY)|(?:\bHULU\b)|(?:DISNEY ?PLUS)|(?:\bHBO\b)|(?:YOUTUBE ?PREMIUM)|(?:APPLE\.COM)|(?:OPENAI)|(?:ANTHROPIC)|(?:\bGITHUB\b)|(?:\bADOBE\b)|(?:DROPBOX)|(?:\bNOTION\b)|(?:AUDIBLE)|(?:PATREON)|(?:ICLOUD)/i],
  ["Health", /(?:\bCVS\b)|(?:WALGREENS)|(?:RITE AID)|(?:PHARMACY)|(?:\bDENTAL\b)|(?:MEDICAL)|(?:\bCLINIC\b)|(?:HOSPITAL)|(?:\bOPTUM\b)|(?:QUEST DIAGNOSTIC)|(?:LABCORP)|(?:ZOCDOC)/i],
  ["Shopping", /(?:AMAZON)|(?:\bAMZN\b)|(?:\bTARGET\b)|(?:WALMART)|(?:BEST BUY)|(?:\bIKEA\b)|(?:HOME DEPOT)|(?:\bLOWES\b)|(?:\bETSY\b)|(?:\bEBAY\b)|(?:UNIQLO)|(?:\bH&M\b)|(?:\bZARA\b)|(?:\bNIKE\b)|(?:\bMACY)/i],
  ["Utilities", /(?:COMCAST)|(?:XFINITY)|(?:VERIZON)|(?:T[- ]?MOBILE)|(?:AT&T)|(?:SPECTRUM)|(?:NATIONAL GRID)|(?:EVERSOURCE)|(?:CON ?EDISON)|(?:ELECTRIC)|(?:WATER DEPT)/i],
  ["Rent", /(?:\bRENT\b)|(?:PROPERTY MGMT)|(?:APARTMENT)|(?:LEASING)|(?:LANDLORD)/i],
  ["Fitness", /(?:PLANET FITNESS)|(?:EQUINOX)|(?:\bGYM\b)|(?:CLASSPASS)|(?:PELOTON)|(?:CROSSFIT)/i],
  ["Entertainment", /(?:\bAMC\b)|(?:\bREGAL\b)|(?:CINEMA)|(?:TICKETMASTER)|(?:STEAM ?GAMES)|(?:PLAYSTATION)|(?:\bXBOX\b)|(?:NINTENDO)|(?:EVENTBRITE)|(?:STUBHUB)|(?:ACTION PARK)|(?:XTREME ACTION)|(?:RACEWAY)|(?:GO ?KART)|(?:TRAMPOLINE)|(?:\bARCADE\b)|(?:BOWLING)|(?:MINI ?GOLF)|(?:AMUSEMENT)|(?:WATER ?PARK)|(?:\bZOO\b)|(?:AQUARIUM)|(?:MUSEUM)/i],
  ["Education", /(?:NORTHEASTERN)|(?:UNIVERSITY)|(?:\bCOLLEGE\b)|(?:COURSERA)|(?:\bUDEMY\b)|(?:TUITION)|(?:BOOKSTORE)|(?:PEARSON)|(?:\bCHEGG\b)/i],
  ["Personal Care", /(?:\bSALON\b)|(?:BARBER)|(?:SEPHORA)|(?:\bULTA\b)|(?:\bSPA\b)|(?:\bNAILS\b)/i],
  ["Fees", /(?:ANNUAL FEE)|(?:LATE FEE)|(?:INTEREST CHARGE)|(?:FOREIGN TRANSACTION)|(?:OVERDRAFT)|(?:ATM FEE)|(?:SERVICE CHARGE)|(?:WIRE FEE)/i],
] as const;
