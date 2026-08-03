import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import PageHeader from '../common/PageHeader';
import MessageContent from '../../components/MessageContent';
import {
  getWhatsAppStatus,
  deleteWhatsAppCredentials,
  sendWhatsAppBulk,
  getScores,
  getCampaignStats,
  getCampaigns,
  updateCampaignStatus,
  recordSent,
  generateAIMessage as generateAIMessageApi,
  getPreviewSettings,
  sendCampaignWithPreview,
  uploadImage,
  getWhatsAppWorkspace,
  getWhatsAppLiveStats,
  getWhatsAppLogs,
  controlWhatsAppCampaign,
  whatsAppAiCompose,
  testWhatsAppConnection,
  sendWhatsAppMedia,
  getConversations,
  saveWhatsAppCredentials,
  validateWhatsAppCredentials,
  getMessages,
  sendConversationReply,
  generateReply,
  autoReply,
  markConversationRead,
  archiveConversation,
  pinConversation,
  unpinConversation,
  listAutomations,
  enableAutomation,
  disableAutomation,
  processDueFollowUps,
  Lead,
  ScoredLead,
  CampaignRecord,
  CampaignStats,
  WhatsAppStatus,
  WhatsAppCredentialsInfo,
  WhatsAppTemplate,
  WhatsAppBulkResponse,
  WhatsAppWorkspaceResponse,
  WhatsAppLiveStats,
  Conversation,
  Message,
} from '../../lib/apiClient';
import {
  buildInitialSelection,
  clearBulkCampaign,
  getTransferredLeadsForChannel,
  hasTransferredLeads,
  isContactsSource,
} from '../../lib/bulkCampaign';
import './whatsapp.css';

const MAX_BATCH = 50;

function errMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

function hasPhone(l: Lead): boolean {
  const p = (l.phone || '').toString().trim();
  return p !== '' && p !== 'N/A' && p !== 'Not Available';
}


/* ===================== Multi-Language AI Message Templates ===================== */
// Architecture: LANG_TEMPLATES[language][goal][tone] = base message
// Future languages can be added by adding a new key. English is the fallback.
// NICHE_LABELS translates common business types for native mode.

const NICHE_LABELS: Record<string, Record<string, string>> = {
  en: { gym: 'gym', dentist: 'dental clinic', lawyer: 'law firm', restaurant: 'restaurant', salon: 'salon', realtor: 'real estate', plumber: 'plumbing service', hvac: 'HVAC service', roofer: 'roofing', electrician: 'electrical service', clinic: 'clinic', accountant: 'accounting', solar: 'solar company', carwash: 'car wash', pest: 'pest control', marketing: 'marketing agency', roofrepair: 'roof repair', beautysalon: 'beauty salon', spa: 'spa', petgrooming: 'pet grooming', cleaningservice: 'cleaning service', landscaping: 'landscaping', movingcompany: 'moving company', photography: 'photography', tutoring: 'tutoring', homerenovation: 'home renovation', interiordesign: 'interior design', catering: 'catering', coffeeshop: 'coffee shop', barbershop: 'barber shop', autorepair: 'auto repair', bikeshop: 'bike shop', yogastudio: 'yoga studio', dancestudio: 'dance studio', musicschool: 'music school', daycare: 'daycare', pharmacy: 'pharmacy', veterinaryclinic: 'veterinary clinic', travelagency: 'travel agency', eventplanning: 'event planning', printingservice: 'printing service', itsupport: 'IT support', webdesign: 'web design', seoagency: 'SEO agency', consultingfirm: 'consulting firm' },
  de: { gym: 'Fitnessstudio', dentist: 'Zahnarztpraxis', lawyer: 'Anwaltskanzlei', restaurant: 'Restaurant', salon: 'Salon', realtor: 'Immobilienbüro', plumber: 'Klempnerei', hvac: 'Klimaanlagen-Service', roofer: 'Dachdecker', electrician: 'Elektrobetrieb', clinic: 'Klinik', accountant: 'Buchhaltung', solar: 'Solarfirma', carwash: 'Autowaschanlage', pest: 'Schädlingsbekämpfung', marketing: 'Marketing-Agentur', roofrepair: 'Dachreparatur', beautysalon: 'Kosmetikstudio', spa: 'Wellness', petgrooming: 'Tierpflege', cleaningservice: 'Reinigungsdienst', landscaping: 'Gartengestaltung', movingcompany: 'Umzugsunternehmen', photography: 'Fotografie', tutoring: 'Nachhilfe', homerenovation: 'Hausrenovierung', interiordesign: 'Innenausstattung', catering: 'Catering', coffeeshop: 'Café', barbershop: 'Barbier', autorepair: 'Autowerkstatt', bikeshop: 'Fahrradladen', yogastudio: 'Yogastudio', dancestudio: 'Tanzstudio', musicschool: 'Musikschule', daycare: 'Kita', pharmacy: 'Apotheke', veterinaryclinic: 'Tierklinik', travelagency: 'Reisebüro', eventplanning: 'Eventplanung', printingservice: 'Druckservice', itsupport: 'IT-Support', webdesign: 'Webdesign', seoagency: 'SEO-Agentur', consultingfirm: 'Beratungsfirma' },
  fr: { gym: 'salle de sport', dentist: 'cabinet dentaire', lawyer: 'cabinet d\'avocats', restaurant: 'restaurant', salon: 'salon', realtor: 'agence immobilière', plumber: 'plomberie', hvac: 'climatisation', roofer: 'toiture', electrician: 'électricien', clinic: 'clinique', accountant: 'comptabilité', solar: 'entreprise solaire', carwash: 'lavage auto', pest: 'désinsectisation', marketing: 'agence marketing', roofrepair: 'réparation de toit', beautysalon: 'institut de beauté', spa: 'spa', petgrooming: 'toilettage', cleaningservice: 'service de nettoyage', landscaping: 'jardinage', movingcompany: 'déménagement', photography: 'photographie', tutoring: 'soutien scolaire', homerenovation: 'rénovation de maison', interiordesign: 'décoration intérieure', catering: 'traiteur', coffeeshop: 'café', barbershop: 'barbier', autorepair: 'garage auto', bikeshop: 'magasin de vélos', yogastudio: 'studio de yoga', dancestudio: 'studio de danse', musicschool: 'école de musique', daycare: 'crèche', pharmacy: 'pharmacie', veterinaryclinic: 'clinique vétérinaire', travelagency: 'agence de voyages', eventplanning: 'organisation d\'événements', printingservice: 'imprimerie', itsupport: 'support informatique', webdesign: 'design web', seoagency: 'agence SEO', consultingfirm: 'cabinet de conseil' },
  es: { gym: 'gimnasio', dentist: 'clínica dental', lawyer: 'bufete de abogados', restaurant: 'restaurante', salon: 'salón', realtor: 'inmobiliaria', plumber: 'fontanería', hvac: 'climatización', roofer: 'techos', electrician: 'electricista', clinic: 'clínica', accountant: 'contabilidad', solar: 'empresa solar', carwash: 'lavado de coches', pest: 'control de plagas', marketing: 'agencia de marketing', roofrepair: 'reparación de techos', beautysalon: 'salón de belleza', spa: 'spa', petgrooming: 'peluquería canina', cleaningservice: 'servicio de limpieza', landscaping: 'jardinería', movingcompany: 'mudanzas', photography: 'fotografía', tutoring: 'clases particulares', homerenovation: 'reforma de casa', interiordesign: 'diseño de interiores', catering: 'catering', coffeeshop: 'cafetería', barbershop: 'barbería', autorepair: 'taller mecánico', bikeshop: 'tienda de bicicletas', yogastudio: 'estudio de yoga', dancestudio: 'estudio de baile', musicschool: 'escuela de música', daycare: 'guardería', pharmacy: 'farmacia', veterinaryclinic: 'clínica veterinaria', travelagency: 'agencia de viajes', eventplanning: 'planificación de eventos', printingservice: 'impresión', itsupport: 'soporte técnico', webdesign: 'diseño web', seoagency: 'agencia SEO', consultingfirm: 'empresa de consultoría' },
  it: { gym: 'palestra', dentist: 'studio dentistico', lawyer: 'studio legale', restaurant: 'ristorante', salon: 'salone', realtor: 'agenzia immobiliare', plumber: 'idraulica', hvac: 'condizionamento', roofer: 'coperture', electrician: 'elettricista', clinic: 'clinica', accountant: 'contabilità', solar: 'azienda solare', carwash: 'autolavaggio', pest: 'disinfestazione', marketing: 'agenzia marketing', roofrepair: 'riparazione tetti', beautysalon: 'salone di bellezza', spa: 'spa', petgrooming: 'toelettatura', cleaningservice: 'pulizie', landscaping: 'giardinaggio', movingcompany: 'traslochi', photography: 'fotografia', tutoring: 'ripetizioni', homerenovation: 'ristrutturazione casa', interiordesign: 'arredamento interni', catering: 'banqueting', coffeeshop: 'caffetteria', barbershop: 'barbiere', autorepair: 'officina auto', bikeshop: 'negozio biciclette', yogastudio: 'studio yoga', dancestudio: 'scuola danza', musicschool: 'scuola musica', daycare: 'asilo', pharmacy: 'farmacia', veterinaryclinic: 'ambulatorio veterinario', travelagency: 'agenzia viaggi', eventplanning: 'organizzazione eventi', printingservice: 'stampa', itsupport: 'supporto IT', webdesign: 'web design', seoagency: 'agenzia SEO', consultingfirm: 'società consulenza' },
  nl: { gym: 'sportschool', dentist: 'tandartspraktijk', lawyer: 'advocatenkantoor', restaurant: 'restaurant', salon: 'salon', realtor: 'makelaarskantoor', plumber: 'loodgietersbedrijf', hvac: 'airco-service', roofer: 'dakdekker', electrician: 'elektricien', clinic: 'kliniek', accountant: 'administratiekantoor', solar: 'zonne-energiebedrijf', carwash: 'autowasstraat', pest: 'ongediertebestrijding', marketing: 'marketingbureau', roofrepair: 'dakreparatie', beautysalon: 'beautysalon', spa: 'spa', petgrooming: 'dierenverzorging', cleaningservice: 'schoonmaakbedrijf', landscaping: 'tuinonderhoud', movingcompany: 'verhuisbedrijf', photography: 'fotografie', tutoring: 'bijles', homerenovation: 'huisrenovatie', interiordesign: 'interieurontwerp', catering: 'catering', coffeeshop: 'koffietent', barbershop: 'kapperszaak', autorepair: 'autogarage', bikeshop: 'fietsenwinkel', yogastudio: 'yogastudio', dancestudio: 'dansstudio', musicschool: 'muziekschool', daycare: 'kinderopvang', pharmacy: 'apotheek', veterinaryclinic: 'dierenkliniek', travelagency: 'reisbureau', eventplanning: 'eventplanning', printingservice: 'drukkerij', itsupport: 'IT-support', webdesign: 'webdesign', seoagency: 'SEO-bureau', consultingfirm: 'adviesbureau' },
  pt: { gym: 'academia', dentist: 'clínica odontológica', lawyer: 'escritório de advocacia', restaurant: 'restaurante', salon: 'salão', realtor: 'imobiliária', plumber: 'encanador', hvac: 'ar-condicionado', roofer: 'telhados', electrician: 'eletricista', clinic: 'clínica', accountant: 'contabilidade', solar: 'empresa de energia solar', carwash: 'lava-rápido', pest: 'controle de pragas', marketing: 'agência de marketing', roofrepair: 'reparo de telhado', beautysalon: 'salão de beleza', spa: 'spa', petgrooming: 'pet shop', cleaningservice: 'serviço de limpeza', landscaping: 'paisagismo', movingcompany: 'mudanças', photography: 'fotografia', tutoring: 'aulas particulares', homerenovation: 'reforma de casa', interiordesign: 'design de interiores', catering: 'buffet', coffeeshop: 'cafeteria', barbershop: 'barbearia', autorepair: 'oficina mecânica', bikeshop: 'loja de bicicletas', yogastudio: 'estúdio de yoga', dancestudio: 'estúdio de dança', musicschool: 'escola de música', daycare: 'creche', pharmacy: 'farmácia', veterinaryclinic: 'clínica veterinária', travelagency: 'agência de viagens', eventplanning: 'organização de eventos', printingservice: 'gráfica', itsupport: 'suporte de TI', webdesign: 'design de sites', seoagency: 'agência de SEO', consultingfirm: 'consultoria' },
  ms: { gym: 'gim', dentist: 'klinik pergigian', lawyer: 'pejabat guaman', restaurant: 'restoran', salon: 'salon', realtor: 'ejen hartanah', plumber: 'tukang paip', hvac: 'servis penghawa dingin', roofer: 'tukang bumbung', electrician: 'tukang elektrik', clinic: 'klinik', accountant: 'perakaunan', solar: 'syarikat solar', carwash: 'cuci kereta', pest: 'kawalan serangga', marketing: 'agensi pemasaran', roofrepair: 'baik pulih bumbung', beautysalon: 'salun kecantikan', spa: 'spa', petgrooming: 'grooming haiwan', cleaningservice: 'perkhidmatan pembersihan', landscaping: 'landskap', movingcompany: 'syarikat pindah', photography: 'fotografi', tutoring: 'tuisyen', homerenovation: 'renovasi rumah', interiordesign: 'rekabentuk dalaman', catering: 'katering', coffeeshop: 'kedai kopi', barbershop: 'kedai gunting rambut', autorepair: 'bengkel kereta', bikeshop: 'kedai basikal', yogastudio: 'studio yoga', dancestudio: 'studio tarian', musicschool: 'sekolah muzik', daycare: 'taska', pharmacy: 'farmasi', veterinaryclinic: 'klinik haiwan', travelagency: 'agensi pelancongan', eventplanning: 'perancangan acara', printingservice: 'perkhidmatan cetakan', itsupport: 'sokongan IT', webdesign: 'reka bentuk web', seoagency: 'agensi SEO', consultingfirm: 'firma perunding' },
  id: { gym: 'pusat kebugaran', dentist: 'klinik gigi', lawyer: 'kantor hukum', restaurant: 'restoran', salon: 'salon', realtor: 'agen properti', plumber: 'tukang pipa', hvac: 'servis AC', roofer: 'jasa atap', electrician: 'tukang listrik', clinic: 'klinik', accountant: 'akuntansi', solar: 'perusahaan tenaga surya', carwash: 'cuci mobil', pest: 'jasa pembasmi hama', marketing: 'agen pemasaran', roofrepair: 'perbaikan atap', beautysalon: 'salon kecantikan', spa: 'spa', petgrooming: 'perawatan hewan', cleaningservice: 'jasa kebersihan', landscaping: 'jasa taman', movingcompany: 'jasa pindahan', photography: 'fotografi', tutoring: 'les privat', homerenovation: 'renovasi rumah', interiordesign: 'desain interior', catering: 'katering', coffeeshop: 'kedai kopi', barbershop: 'barber shop', autorepair: 'bengkel mobil', bikeshop: 'toko sepeda', yogastudio: 'studio yoga', dancestudio: 'studio tari', musicschool: 'sekolah musik', daycare: 'penitipan anak', pharmacy: 'apotek', veterinaryclinic: 'klinik hewan', travelagency: 'agen perjalanan', eventplanning: 'perencana acara', printingservice: 'jasa cetak', itsupport: 'dukungan IT', webdesign: 'desain web', seoagency: 'agen SEO', consultingfirm: 'firma konsultasi' },
  fil: { gym: 'gimnasya', dentist: 'klinika ng ngipin', lawyer: 'tanggapan ng abogado', restaurant: 'restawran', salon: 'salon', realtor: 'ahente ng real estate', plumber: 'serbisyo ng tubo', hvac: 'serbisyo ng aircon', roofer: 'serbisyo ng bubong', electrician: 'elektrisista', clinic: 'klinika', accountant: 'akawntant', solar: 'kumpanya ng solar', carwash: 'paghuhugas ng kotse', pest: 'kontrol ng peste', marketing: 'ahensya ng marketing', roofrepair: 'pagkumpuni ng bubong', beautysalon: 'salon ng kagandahan', spa: 'spa', petgrooming: 'pag-aalaga ng alaga', cleaningservice: 'serbisyo ng paglilinis', landscaping: 'pag-aayos ng hardin', movingcompany: 'kumpanya ng lipat-bahay', photography: 'potograpiya', tutoring: 'pribadong pagtuturo', homerenovation: 'renobasyon ng bahay', interiordesign: 'disenyo ng loob', catering: 'katering', coffeeshop: 'kapihan', barbershop: 'barberya', autorepair: 'talyer ng kotse', bikeshop: 'tindahan ng bisikleta', yogastudio: 'studio ng yoga', dancestudio: 'studio ng sayaw', musicschool: 'paaralan ng musika', daycare: 'daycare', pharmacy: 'botika', veterinaryclinic: 'klinika ng hayop', travelagency: 'ahensya ng paglalakbay', eventplanning: 'pagpaplano ng okasyon', printingservice: 'serbisyo ng pag-imprenta', itsupport: 'suporta sa IT', webdesign: 'disenyo ng web', seoagency: 'ahensya ng SEO', consultingfirm: 'firmang pangkonsulta' },
  bn: { gym: 'জিম', dentist: 'ডেন্টাল ক্লিনিক', lawyer: 'আইনজীবী অফিস', restaurant: 'রেস্তোরাঁ', salon: 'সেলুন', realtor: 'রিয়েল এস্টেট', plumber: 'প্লাম্বিং', hvac: 'এসি সার্ভিস', roofer: 'ছাদ মেরামত', electrician: 'বিদ্যুত্সেবা', clinic: 'ক্লিনিক', accountant: 'হিসাব বিভাগ', solar: 'সোলার কোম্পানি', carwash: 'গাড়ি ধোয়া', pest: 'পোকামাকড় নিয়ন্ত্রণ', marketing: 'মার্কেটিং এজেন্সি', roofrepair: 'ছাদ মেরামত', beautysalon: 'বিউটি সেলুন', spa: 'স্পা', petgrooming: 'পোষা প্রাণীর পরিচর্যা', cleaningservice: 'পরিষ্কার সেবা', landscaping: 'ল্যান্ডস্কেপিং', movingcompany: 'পরিবহন সেবা', photography: 'ফটোগ্রাফি', tutoring: 'প্রাইভেট টিউশন', homerenovation: 'বাড়ি সংস্কার', interiordesign: 'আভ্যন্তরীণ নকশা', catering: 'খাবার সরবরাহ', coffeeshop: 'কফি হাউস', barbershop: 'নাপিতের দোকান', autorepair: 'গাড়ি মেরামত', bikeshop: 'সাইকেলের দোকান', yogastudio: 'যোগ স্টুডিও', dancestudio: 'নৃত্য বিদ্যালয়', musicschool: 'সংগীত বিদ্যালয়', daycare: 'ডে-কেয়ার', pharmacy: 'ফার্মেসি', veterinaryclinic: 'পশু ক্লিনিক', travelagency: 'ট্র্যাভেল এজেন্সি', eventplanning: 'ইভেন্ট পরিকল্পনা', printingservice: 'প্রিন্টিং সেবা', itsupport: 'আইটি সহায়তা', webdesign: 'ওয়েব ডিজাইন', seoagency: 'এসইও এজেন্সি', consultingfirm: 'পরামর্শ প্রতিষ্ঠান' },
  ur: { gym: 'جم', dentist: 'ڈینٹل کلینک', lawyer: 'قانونی دفتر', restaurant: 'ریسٹورنٹ', salon: 'سیلون', realtor: 'رئیل اسٹیٹ', plumber: 'پلمبرنگ', hvac: 'اے سی سروس', roofer: 'چھت مرمت', electrician: 'بجلی کا کام', clinic: 'کلینک', accountant: 'اکاؤنٹنگ', solar: 'سولر کمپنی', carwash: 'کار واش', pest: 'کیڑوں کا کنٹرول', marketing: 'مارکیٹنگ ایجنسی', roofrepair: 'چھت کی مرمت', beautysalon: 'بیوٹی سیلون', spa: 'سپا', petgrooming: 'پالتو جانوروں کی دیکھ بھال', cleaningservice: 'صفائی کی خدمات', landscaping: 'باغبانی', movingcompany: 'نقل مکانی', photography: 'فوٹوگرافی', tutoring: 'پرائیوٹ ٹیوشن', homerenovation: 'گھر کی مرمت', interiordesign: 'اندرونی ڈیزائن', catering: 'کیٹرنگ', coffeeshop: 'کافی شاپ', barbershop: 'نائی کی دکان', autorepair: 'گاڑیوں کی مرمت', bikeshop: 'سائیکل کی دکان', yogastudio: 'یوگا اسٹوڈیو', dancestudio: 'رقص کی کلاس', musicschool: 'موسیقی کی کلاس', daycare: 'ڈے کیئر', pharmacy: 'دواخانہ', veterinaryclinic: 'جانوروں کا کلینک', travelagency: 'ٹریول ایجنسی', eventplanning: 'ایونٹ پلاننگ', printingservice: 'پرنٹنگ سروس', itsupport: 'آئی ٹی سپورٹ', webdesign: 'ویب ڈیزائن', seoagency: 'ایس ای او ایجنسی', consultingfirm: 'مشاورتی ادارہ' },
};

const LANG_TEMPLATES: Record<string, Record<string, Record<string, string>>> = {
  en: {
    booking: {
      professional: "Hi {name}, we help {niche} businesses in {city} get more bookings with AI. Would you be open to a quick 10-minute call? Reply YES and I'll share a calendar link.",
      friendly: "Hey {name}! 👋 We help {niche} businesses in {city} get more bookings effortlessly. Want a quick 10-min call? Just reply YES!",
      casual: "Hi {name}, quick question — we help {niche} spots in {city} book more clients. Up for a 10-min chat? Reply YES ✌️",
      luxury: "Good day {name}. We elevate {niche} establishments in {city} with bespoke AI solutions. May we schedule a brief consultation?",
      aggressive: "{name}, your {niche} competitors in {city} are already using AI to steal your customers. Book a 10-min call NOW. Reply YES.",
    },
    demo: {
      professional: "Hi {name}, I came across your {niche} in {city}. I'd love to show you a personalized demo of our AI lead system. Are you free for a brief 15-minute walkthrough?",
      friendly: "Hey {name}! I found your {niche} in {city} and would love to show you a quick demo of how our AI brings in more leads. Interested? 😊",
      casual: "Hi {name}, saw your {niche} in {city} — our AI demo is pretty cool and only takes 15 mins. Wanna see it?",
      luxury: "Dear {name}, we would be honored to present a tailored demonstration of our AI platform for your {niche} in {city}. Shall we arrange a private session?",
      aggressive: "{name}, stop guessing with your {niche} in {city}. Watch our AI demo and see exactly how many leads you'll get in 30 days. Book it NOW.",
    },
    followup: {
      professional: "Hi {name}, following up on my message about helping {niche} businesses in {city} grow with AI. Any questions I can help with?",
      friendly: "Hey {name}, just circling back! 😊 Any thoughts on how we can help your {niche} in {city} get more leads? Happy to answer anything!",
      casual: "Hi {name}, just bumping this to the top of your inbox. Still interested in growing your {niche} in {city}? No pressure!",
      luxury: "Dear {name}, I wanted to graciously follow up regarding our conversation about enhancing your {niche} in {city}. Please let us know how we may assist.",
      aggressive: "{name}, I haven't heard back. Your {niche} in {city} is losing leads every single day you wait. Let's talk — reply now.",
    },
    offer: {
      professional: "Hi {name}, exclusive offer for {niche} businesses in {city}: 50% off your first month of AI lead generation. Limited time. Reply INTERESTED to claim your spot.",
      friendly: "Hey {name}! 🎉 Special deal just for {niche} businesses in {city}: 50% off your first month with our AI! Reply INTERESTED to grab it.",
      casual: "Hi {name}, heads up — {niche} businesses in {city} get 50% off first month right now. Pretty sweet deal. Reply INTERESTED if you want in.",
      luxury: "Dear {name}, as a distinguished {niche} in {city}, we extend an exclusive invitation: 50% off your first month of our premium AI lead generation. Reply INTERESTED to secure this privilege.",
      aggressive: "{name}, your {niche} competitors in {city} just got this 50% OFF AI deal. Only a few spots left. Reply INTERESTED before they take them all.",
    },
    meeting: {
      professional: "Hi {name}, would you be available for a brief 15-minute meeting this week to discuss how AI can help your {niche} in {city} attract more customers? Let me know a time that works.",
      friendly: "Hey {name}! Would love to hop on a quick 15-min call this week to chat about growing your {niche} in {city}. What day works for you? 📅",
      casual: "Hi {name}, 15-min call this week? We can talk about getting more customers for your {niche} in {city}. You pick the day.",
      luxury: "Dear {name}, we would be delighted to arrange a private 15-minute consultation to explore how AI can elevate your {niche} in {city}. Please share your preferred time.",
      aggressive: "{name}, book a 15-min call THIS WEEK. I'll show you exactly how to dominate {city} as a {niche}. No fluff, just results. Reply with your best time.",
    },
  },
  // Future-ready: add new languages by adding a top-level key. English fallback is automatic.
  de: {
    booking: {
      professional: "Guten Tag {name}, wir unterstützen {niche} in {city} dabei, mit intelligenter Software mehr Termine zu bekommen. Hätten Sie 10 Minuten für ein kurzes Gespräch? Antworten Sie bitte mit JA.",
      friendly: "Hallo {name}! 👋 Wir helfen {niche} in {city}, ganz einfach mehr Kunden zu gewinnen. Lust auf ein kurzes 10-Minuten-Gespräch? Schreiben Sie einfach JA!",
      casual: "Hey {name}, kurze Frage — wir helfen {niche} in {city}, mehr Termine zu kriegen. Hast du 10 Minuten? Antworte mit JA ✌️",
      luxury: "Sehr geehrte/r {name}, wir heben {niche} in {city} auf ein neues Niveau mit maßgeschneiderten Technologien. Dürfen wir einen Termin vereinbaren?",
      aggressive: "{name}, Ihre Konkurrenz in {city} nutzt schon clevere Werkzeuge um Ihre Kunden abzuziehen. Rufen Sie JETZT an, bevor Sie mehr verlieren. Antworten Sie JA.",
    },
    demo: {
      professional: "Guten Tag {name}, ich habe Ihr {niche} in {city} entdeckt. Ich zeige Ihnen gerne in 15 Minuten, wie unsere Software mehr Anfragen bringt. Haben Sie Zeit?",
      friendly: "Hallo {name}! Ich habe Ihr {niche} in {city} gefunden und würde dir gerne zeigen, wie wir mehr Kunden anziehen. Interessiert? 😊",
      casual: "Hey {name}, gesehen dass du ein {niche} in {city} hast — unsere Demo ist ziemlich gut und dauert nur 15 Min. Willst du sie sehen?",
      luxury: "Sehr geehrte/r {name}, wir würden uns freuen, Ihnen eine exklusive, persönliche Vorstellung für Ihr {niche} in {city} zu geben. Vereinbaren wir einen Termin?",
      aggressive: "{name}, hören Sie auf zu raten mit Ihrem {niche} in {city}. Sehen Sie unsere Demo und erfahren Sie genau, wie viele Kunden Sie in 30 Tagen bekommen. Jetzt buchen.",
    },
    followup: {
      professional: "Guten Tag {name}, ich melde mich nochmals bezüglich intelligenten Lösungen für {niche} in {city}. Haben Sie Fragen?",
      friendly: "Hallo {name}, ich wollte nochmal nachfragen! 😊 Gibt es Gedanken dazu, wie wir Ihr {niche} in {city} wachsen lassen können?",
      casual: "Hey {name}, ich schiebe das mal wieder nach oben in deinem Posteingang. Immer noch interessiert, dein {niche} in {city} zu skalieren? Kein Druck!",
      luxury: "Sehr geehrte/r {name}, ich möchte mich höflich erkundigen, wie wir Ihr {niche} in {city} weiter unterstützen können.",
      aggressive: "{name}, ich habe nichts gehört. Ihr {niche} in {city} verliert jeden Tag Kunden. Lassen Sie uns reden — antworten Sie jetzt.",
    },
    offer: {
      professional: "Guten Tag {name}, exklusives Angebot für {niche} in {city}: 50 Prozent Rabatt im ersten Monat. Zeitlich begrenzt. Antworten Sie mit INTERESSIERT.",
      friendly: "Hallo {name}! 🎉 Sonderdeal nur für {niche} in {city}: 50 Prozent Rabatt im ersten Monat! Schreiben Sie INTERESSIERT um zuzugreifen.",
      casual: "Hey {name}, zur Info — {niche} in {city} bekommen gerade 50 Prozent Rabatt im ersten Monat. Ziemlich gutes Angebot. Schreib INTERESSIERT wenn du dabei sein willst.",
      luxury: "Sehr geehrte/r {name}, als angesehenes {niche} in {city} laden wir Sie exklusiv ein: 50 Prozent Rabatt im ersten Monat unseres Premium-Services. Antworten Sie mit INTERESSIERT.",
      aggressive: "{name}, Ihre Konkurrenz in {city} hat dieses 50-Prozent-Angebot schon ergattert. Nur noch wenige Plätze. Antworten Sie mit INTERESSIERT.",
    },
    meeting: {
      professional: "Guten Tag {name}, hätten Sie diese Woche 15 Minuten für ein Gespräch darüber, wie clevere Werkzeuge Ihr {niche} in {city} mehr Kunden bringen?",
      friendly: "Hallo {name}! Lust auf ein kurzes 15-Minuten-Gespräch diese Woche über das Wachstum Ihres {niche} in {city}? Welcher Tag passt dir? 📅",
      casual: "Hey {name}, 15-Minuten-Anruf diese Woche? Wir können über mehr Kunden für dein {niche} in {city} reden. Du wählst den Tag.",
      luxury: "Sehr geehrte/r {name}, wir würden uns freuen, eine private 15-Minuten-Beratung zu vereinbaren, um zu besprechen, wie wir Ihr {niche} in {city} heben können.",
      aggressive: "{name}, buchen Sie einen 15-Minuten-Anruf DIESE WOCHE. Ich zeige Ihnen genau, wie Sie {city} als {niche} dominieren. Kein Bluff, nur Ergebnisse. Antworten Sie mit Ihrer besten Zeit.",
    },
  },
  fr: {
    booking: {
      professional: "Bonjour {name}, nous aidons les {niche} à {city} à obtenir plus de rendez-vous avec des outils intelligents. Auriez-vous 10 minutes pour un appel? Répondez OUI.",
      friendly: "Salut {name}! 👋 On aide les {niche} à {city} à attirer plus de clients facilement. Envie d'un appel de 10 minutes? Réponds OUI!",
      casual: "Hey {name}, petite question — on aide les {niche} à {city} à réserver plus de clients. Tu as 10 minutes? Réponds OUI ✌️",
      luxury: "Bonjour {name}, nous élevons les {niche} à {city} avec des solutions technologiques sur mesure. Pouvons-nous fixer un rendez-vous?",
      aggressive: "{name}, vos concurrents à {city} utilisent déjà des outils intelligents pour vous voler vos clients. Appelez MAINTENANT avant d'en perdre plus. Répondez OUI.",
    },
    demo: {
      professional: "Bonjour {name}, j'ai découvert votre {niche} à {city}. J'aimerais vous montrer en 15 minutes comment nos outils apportent plus de demandes. Vous avez le temps?",
      friendly: "Salut {name}! J'ai trouvé ton {niche} à {city} et j'aimerais te montrer comment on attire plus de clients. Ça t'intéresse? 😊",
      casual: "Hey {name}, j'ai vu ton {niche} à {city} — notre démo est plutôt géniale et dure 15 minutes. Tu veux la voir?",
      luxury: "Cher/Chère {name}, nous serions honorés de vous présenter une démonstration exclusive pour votre {niche} à {city}. Organisons-nous?",
      aggressive: "{name}, arrêtez de deviner avec votre {niche} à {city}. Regardez notre démo et voyez exactement combien de clients vous obtiendrez en 30 jours. Réservez maintenant.",
    },
    followup: {
      professional: "Bonjour {name}, je reprends contact concernant nos solutions pour les {niche} à {city}. Avez-vous des questions?",
      friendly: "Salut {name}, je repasse par ici! 😊 Des idées sur la façon dont on peut faire croître ton {niche} à {city}?",
      casual: "Hey {name}, je remonte ça dans ta boîte. Toujours intéressé par la croissance de ton {niche} à {city}? Pas de pression!",
      luxury: "Cher/Chère {name}, je voulais prendre de vos nouvelles concernant l'amélioration de votre {niche} à {city}. Comment pouvons-nous vous aider davantage?",
      aggressive: "{name}, je n'ai pas eu de réponse. Votre {niche} à {city} perd des clients chaque jour que vous attendez. Parlons — répondez maintenant.",
    },
    offer: {
      professional: "Bonjour {name}, offre exclusive pour les {niche} à {city}: 50 pour cent de réduction le premier mois. Durée limitée. Répondez INTÉRESSÉ.",
      friendly: "Salut {name}! 🎉 Offre spéciale juste pour les {niche} à {city}: 50 pour cent de réduction le premier mois! Réponds INTÉRESSÉ pour en profiter.",
      casual: "Hey {name}, pour info — les {niche} à {city} ont 50 pour cent de réduction le premier mois en ce moment. Bon plan. Réponds INTÉRESSÉ si tu veux en faire partie.",
      luxury: "Cher/Chère {name}, en tant que {niche} distingué à {city}, nous vous invitons exclusivement: 50 pour cent de réduction sur le premier mois. Répondez INTÉRESSÉ.",
      aggressive: "{name}, vos concurrents à {city} ont déjà eu cette offre à moins 50 pour cent. Plus que quelques places. Répondez INTÉRESSÉ avant qu'ils ne les prennent toutes.",
    },
    meeting: {
      professional: "Bonjour {name}, auriez-vous 15 minutes cette semaine pour discuter de la façon dont nos outils aident votre {niche} à {city} à attirer plus de clients?",
      friendly: "Salut {name}! Envie d'un appel de 15 minutes cette semaine pour parler de la croissance de ton {niche} à {city}? Quel jour te va? 📅",
      casual: "Hey {name}, appel de 15 minutes cette semaine? On peut parler d'attirer plus de clients pour ton {niche} à {city}. Tu choisis le jour.",
      luxury: "Cher/Chère {name}, nous serions ravis d'organiser une consultation privée de 15 minutes pour explorer comment élever votre {niche} à {city}.",
      aggressive: "{name}, réservez un appel de 15 minutes CETTE SEMAINE. Je vous montre exactement comment dominer {city} en tant que {niche}. Pas de bla-bla, que des résultats. Répondez avec votre meilleur créneau.",
    },
  },
  es: {
    booking: {
      professional: "Hola {name}, ayudamos a {niche} en {city} a conseguir más citas con herramientas inteligentes. ¿Tienes 10 minutos para una llamada? Responde SÍ.",
      friendly: "¡Hola {name}! 👋 Ayudamos a {niche} en {city} a atraer más clientes fácilmente. ¿Quieres una llamada rápida de 10 minutos? ¡Responde SÍ!",
      casual: "Ey {name}, pregunta rápida — ayudamos a {niche} en {city} a reservar más clientes. ¿Tienes 10 minutos? Responde SÍ ✌️",
      luxury: "Buen día {name}, elevamos a {niche} en {city} con soluciones tecnológicas a medida. ¿Podemos agendar una consulta?",
      aggressive: "{name}, tus competidores en {city} ya usan herramientas inteligentes para robarte clientes. Llama AHORA antes de perder más. Responde SÍ.",
    },
    demo: {
      professional: "Hola {name}, encontré tu {niche} en {city}. Me encantaría mostrarte en 15 minutos cómo nuestras herramientas traen más solicitudes. ¿Tienes tiempo?",
      friendly: "¡Hola {name}! Encontré tu {niche} en {city} y me encantaría mostrarte cómo atraemos más clientes. ¿Te interesa? 😊",
      casual: "Ey {name}, vi tu {niche} en {city} — nuestra demo es bastante genial y dura 15 min. ¿Quieres verla?",
      luxury: "Estimado/a {name}, sería un honor presentarle una demostración exclusiva para su {niche} en {city}. ¿Organizamos una sesión?",
      aggressive: "{name}, deja de adivinar con tu {niche} en {city}. Mira nuestra demo y ve exactamente cuántos clientes conseguirás en 30 días. Reserva ahora.",
    },
    followup: {
      professional: "Hola {name}, te escribo de nuevo sobre nuestras soluciones para {niche} en {city}. ¿Alguna pregunta?",
      friendly: "¡Hola {name}, vuelvo a escribir! 😊 ¿Alguna idea sobre cómo podemos hacer crecer tu {niche} en {city}?",
      casual: "Ey {name}, subo esto otra vez a tu bandeja. ¿Sigues interesado en hacer crecer tu {niche} en {city}? ¡Sin presión!",
      luxury: "Estimado/a {name}, quería dar seguimiento a nuestra conversación sobre mejorar su {niche} en {city}. ¿Cómo podemos ayudarle más?",
      aggressive: "{name}, no he recibido respuesta. Tu {niche} en {city} pierde clientes cada día que esperas. Hablemos — responde ahora.",
    },
    offer: {
      professional: "Hola {name}, oferta exclusiva para {niche} en {city}: 50 por ciento de descuento el primer mes. Tiempo limitado. Responde INTERESADO.",
      friendly: "¡Hola {name}! 🎉 Oferta especial solo para {niche} en {city}: ¡50 por ciento de descuento el primer mes! Responde INTERESADO para aprovecharla.",
      casual: "Ey {name}, aviso — los {niche} en {city} tienen 50 por ciento de descuento el primer mes ahora. Buen trato. Responde INTERESADO si quieres entrar.",
      luxury: "Estimado/a {name}, como distinguido {niche} en {city}, le extendemos una invitación exclusiva: 50 por ciento de descuento el primer mes. Responda INTERESADO.",
      aggressive: "{name}, tus competidores en {city} ya se llevaron esta oferta del 50 por ciento. Quedan pocas plazas. Responde INTERESADO antes de que se las lleven.",
    },
    meeting: {
      professional: "Hola {name}, ¿tienes 15 minutos esta semana para hablar sobre cómo nuestras herramientas ayudan a tu {niche} en {city} a atraer más clientes?",
      friendly: "¡Hola {name}! ¿Te apetece una llamada de 15 minutos esta semana para hablar del crecimiento de tu {niche} en {city}? ¿Qué día te va? 📅",
      casual: "Ey {name}, ¿llamada de 15 minutos esta semana? Podemos hablar de atraer más clientes para tu {niche} en {city}. Tú eliges el día.",
      luxury: "Estimado/a {name}, nos encantaría organizar una consulta privada de 15 minutos para explorar cómo elevar su {niche} en {city}.",
      aggressive: "{name}, reserva una llamada de 15 minutos ESTA SEMANA. Te muestro exactamente cómo dominar {city} como {niche}. Sin relleno, solo resultados. Responde con tu mejor horario.",
    },
  },
  it: {
    booking: {
      professional: "Ciao {name}, aiutiamo i {niche} a {city} a ottenere più appuntamenti con strumenti intelligenti. Hai 10 minuti per una chiamata? Rispondi SÌ.",
      friendly: "Ciao {name}! 👋 Aiutiamo i {niche} a {city} ad attirare più clienti senza sforzo. Ti va una chiamata veloce di 10 minuti? Rispondi SÌ!",
      casual: "Ehi {name}, domanda veloce — aiutiamo i {niche} a {city} a prenotare più clienti. Hai 10 minuti? Rispondi SÌ ✌️",
      luxury: "Buongiorno {name}, eleviamo i {niche} a {city} con soluzioni tecnologiche su misura. Possiamo fissare un appuntamento?",
      aggressive: "{name}, i tuoi concorrenti a {city} usano già strumenti intelligenti per rubarti i clienti. Chiama ORA prima di perderne altri. Rispondi SÌ.",
    },
    demo: {
      professional: "Ciao {name}, ho trovato il tuo {niche} a {city}. Mi piacerebbe mostrarti in 15 minuti come i nostri strumenti portano più richieste. Hai tempo?",
      friendly: "Ciao {name}! Ho trovato il tuo {niche} a {city} e mi piacerebbe mostrarti come attiriamo più clienti. Ti interessa? 😊",
      casual: "Ehi {name}, ho visto il tuo {niche} a {city} — la nostra demo è davvero bella e dura 15 min. Vuoi vederla?",
      luxury: "Gentile {name}, saremmo onorati di presentarle una dimostrazione esclusiva per il suo {niche} a {city}. Organizziamo?",
      aggressive: "{name}, smetti di indovinare con il tuo {niche} a {city}. Guarda la nostra demo e vedi esattamente quanti clienti otterrai in 30 giorni. Prenota ora.",
    },
    followup: {
      professional: "Ciao {name}, ti ricontatto riguardo alle nostre soluzioni per i {niche} a {city}. Hai domande?",
      friendly: "Ciao {name}, torno a scriverti! 😊 Hai idee su come possiamo far crescere il tuo {niche} a {city}?",
      casual: "Ehi {name}, riporto questo in cima alla tua casella. Ancora interessato a far crescere il tuo {niche} a {city}? Nessuna pressione!",
      luxury: "Gentile {name}, volevo gentilmente seguire la nostra conversazione su come migliorare il suo {niche} a {city}. Come possiamo aiutarla ulteriormente?",
      aggressive: "{name}, non ho ricevuto risposta. Il tuo {niche} a {city} perde clienti ogni giorno che aspetti. Parliamo — rispondi ora.",
    },
    offer: {
      professional: "Ciao {name}, offerta esclusiva per i {niche} a {city}: 50 per cento di sconto il primo mese. Tempo limitato. Rispondi INTERESSATO.",
      friendly: "Ciao {name}! 🎉 Offerta speciale solo per i {niche} a {city}: 50 per cento di sconto il primo mese! Rispondi INTERESSATO per approfittarne.",
      casual: "Ehi {name}, per info — i {niche} a {city} hanno il 50 per cento di sconto il primo mese adesso. Ottimo affare. Rispondi INTERESSATO se vuoi entrare.",
      luxury: "Gentile {name}, come distinto {niche} a {city}, le estendiamo un invito esclusivo: 50 per cento di sconto il primo mese. Risponda INTERESSATO.",
      aggressive: "{name}, i tuoi concorrenti a {city} hanno già approfittato di questa offerta al 50 per cento. Solo pochi posti rimasti. Rispondi INTERESSATO.",
    },
    meeting: {
      professional: "Ciao {name}, hai 15 minuti questa settimana per parlare di come i nostri strumenti aiutano il tuo {niche} a {city} ad attirare più clienti?",
      friendly: "Ciao {name}! Ti va una chiamata di 15 minuti questa settimana per parlare della crescita del tuo {niche} a {city}? Che giorno ti va? 📅",
      casual: "Ehi {name}, chiamata di 15 minuti questa settimana? Possiamo parlare di come attirare più clienti per il tuo {niche} a {city}. Scegli tu il giorno.",
      luxury: "Gentile {name}, saremmo lieti di organizzare una consulenza privata di 15 minuti per esplorare come elevare il suo {niche} a {city}.",
      aggressive: "{name}, prenota una chiamata di 15 minuti QUESTA SETTIMANA. Ti mostro esattamente come dominare {city} come {niche}. Niente fronzoli, solo risultati. Rispondi con il tuo orario migliore.",
    },
  },
  nl: {
    booking: {
      professional: "Hallo {name}, we helpen {niche} in {city} met slimme software om meer afspraken te krijgen. Heeft u 10 minuten voor een gesprek? Antwoord met JA.",
      friendly: "Hallo {name}! 👋 We helpen {niche} in {city} om moeiteloos meer klanten te krijgen. Zin in een kort 10-minuten-gesprek? Antwoord gewoon JA!",
      casual: "Hoi {name}, korte vraag — we helpen {niche} in {city} om meer afspraken te boeken. Heb je 10 minuten? Antwoord met JA ✌️",
      luxury: "Goedendag {name}, we tillen {niche} in {city} naar een hoger niveau met op maat gemaakte technologie. Kunnen we een afspraak maken?",
      aggressive: "{name}, uw concurrenten in {city} gebruiken al slimme hulpmiddelen om uw klanten af te pakken. Bel NU voordat u meer verliest. Antwoord met JA.",
    },
    demo: {
      professional: "Hallo {name}, ik vond uw {niche} in {city}. Ik laat u graag in 15 minuten zien hoe onze software meer aanvragen oplevert. Heeft u tijd?",
      friendly: "Hallo {name}! Ik vond uw {niche} in {city} en zou u graag willen laten zien hoe we meer klanten aantrekken. Geïnteresseerd? 😊",
      casual: "Hoi {name}, zag dat je een {niche} in {city} hebt — onze demo is best gaaf en duurt maar 15 min. Wil je hem zien?",
      luxury: "Geachte {name}, het zou ons een eer zijn u een exclusieve, persoonlijke presentatie te geven voor uw {niche} in {city}. Kunnen we een afspraak maken?",
      aggressive: "{name}, stop met gissen met uw {niche} in {city}. Bekijk onze demo en zie precies hoeveel klanten u in 30 dagen krijgt. Nu boeken.",
    },
    followup: {
      professional: "Hallo {name}, ik neem nogmaals contact op over slimme oplossingen voor {niche} in {city}. Heeft u vragen?",
      friendly: "Hallo {name}, ik kom even terug! 😊 Heb je ideeën over hoe we uw {niche} in {city} kunnen laten groeien?",
      casual: "Hoi {name}, ik duw dit even naar boven in je postvak. Nog steeds geïnteresseerd in het groeien van je {niche} in {city}? Geen druk!",
      luxury: "Geachte {name}, ik wilde u graag volgen over het verbeteren van uw {niche} in {city}. Hoe kunnen we u verder helpen?",
      aggressive: "{name}, ik heb niets gehoord. Uw {niche} in {city} verliest elke dag klanten. Laten we praten — antwoord nu.",
    },
    offer: {
      professional: "Hallo {name}, exclusief aanbod voor {niche} in {city}: 50 procent korting de eerste maand. Tijdelijk. Antwoord met GEÏNTERESSEERD.",
      friendly: "Hallo {name}! 🎉 Speciaal aanbod alleen voor {niche} in {city}: 50 procent korting de eerste maand! Antwoord GEÏNTERESSEERD om mee te doen.",
      casual: "Hoi {name}, ter info — {niche} in {city} krijgen nu 50 procent korting de eerste maand. Beste aanbod. Antwoord GEÏNTERESSEERD als je mee wilt doen.",
      luxury: "Geachte {name}, als vooraanstaand {niche} in {city} nodigen wij u exclusief uit: 50 procent korting de eerste maand. Antwoord met GEÏNTERESSEERD.",
      aggressive: "{name}, uw concurrenten in {city} hebben deze 50-procent-aanbod al te pakken. Nog maar een paar plekken. Antwoord GEÏNTERESSEERD.",
    },
    meeting: {
      professional: "Hallo {name}, heeft u deze week 15 minuten om te bespreken hoe slimme hulpmiddelen uw {niche} in {city} meer klanten opleveren?",
      friendly: "Hallo {name}! Zin in een kort 15-minuten-gesprek deze week over het groeien van uw {niche} in {city}? Welke dag schikt u? 📅",
      casual: "Hoi {name}, 15-minuten-belletje deze week? We kunnen praten over meer klanten voor je {niche} in {city}. Jij kiest de dag.",
      luxury: "Geachte {name}, we zouden het op prijs stellen een privé-consult van 15 minuten te plannen om te verkennen hoe we uw {niche} in {city} kunnen tillen.",
      aggressive: "{name}, boek een 15-minuten-gesprek DEZE WEEK. Ik laat u precies zien hoe u {city} domineert als {niche}. Geen geneuzel, alleen resultaten. Antwoord met uw beste tijd.",
    },
  },
  pt: {
    booking: {
      professional: "Olá {name}, ajudamos {niche} em {city} a conseguir mais agendamentos com ferramentas inteligentes. Tem 10 minutos para uma chamada? Responda SIM.",
      friendly: "Oi {name}! 👋 Ajudamos {niche} em {city} a atrair mais clientes sem esforço. Quer uma chamada rápida de 10 minutos? Responda SIM!",
      casual: "Ei {name}, pergunta rápida — ajudamos {niche} em {city} a agendar mais clientes. Tem 10 minutos? Responda SIM ✌️",
      luxury: "Bom dia {name}, elevamos {niche} em {city} com soluções tecnológicas sob medida. Podemos marcar uma consulta?",
      aggressive: "{name}, seus concorrentes em {city} já usam ferramentas inteligentes para roubar seus clientes. Ligue AGORA antes de perder mais. Responda SIM.",
    },
    demo: {
      professional: "Olá {name}, encontrei seu {niche} em {city}. Gostaria de mostrar em 15 minutos como nossas ferramentas trazem mais solicitações. Tem tempo?",
      friendly: "Oi {name}! Encontrei seu {niche} em {city} e adoraria mostrar como atraímos mais clientes. Interessado? 😊",
      casual: "Ei {name}, vi seu {niche} em {city} — nossa demo é bem legal e dura 15 min. Quer ver?",
      luxury: "Prezado/a {name}, seria uma honra apresentar uma demonstração exclusiva para o seu {niche} em {city}. Podemos organizar?",
      aggressive: "{name}, pare de adivinhar com seu {niche} em {city}. Assista nossa demo e veja exatamente quantos clientes você obterá em 30 dias. Reserve agora.",
    },
    followup: {
      professional: "Olá {name}, retornando sobre nossas soluções para {niche} em {city}. Alguma pergunta?",
      friendly: "Oi {name}, voltando a escrever! 😊 Alguma ideia sobre como podemos fazer seu {niche} em {city} crescer?",
      casual: "Ei {name}, subindo isso de novo na sua caixa. Ainda interessado em fazer seu {niche} em {city} crescer? Sem pressão!",
      luxury: "Prezado/a {name}, queria acompanhar nossa conversa sobre melhorar seu {niche} em {city}. Como podemos ajudar mais?",
      aggressive: "{name}, não recebi resposta. Seu {niche} em {city} perde clientes a cada dia que você espera. Vamos conversar — responda agora.",
    },
    offer: {
      professional: "Olá {name}, oferta exclusiva para {niche} em {city}: 50 por cento de desconto no primeiro mês. Tempo limitado. Responda INTERESSADO.",
      friendly: "Oi {name}! 🎉 Oferta especial só para {niche} em {city}: 50 por cento de desconto no primeiro mês! Responda INTERESSADO para aproveitar.",
      casual: "Ei {name}, aviso — {niche} em {city} têm 50 por cento de desconto no primeiro mês agora. Boa oferta. Responda INTERESSADO se quiser entrar.",
      luxury: "Prezado/a {name}, como distinto {niche} em {city}, estendemos um convite exclusivo: 50 por cento de desconto no primeiro mês. Responda INTERESSADO.",
      aggressive: "{name}, seus concorrentes em {city} já aproveitaram esta oferta de 50 por cento. Restam poucas vagas. Responda INTERESSADO antes que acabem.",
    },
    meeting: {
      professional: "Olá {name}, tem 15 minutos esta semana para conversar sobre como nossas ferramentas ajudam seu {niche} em {city} a atrair mais clientes?",
      friendly: "Oi {name}! Quer uma chamada de 15 minutos esta semana para conversar sobre o crescimento do seu {niche} em {city}? Que dia funciona para você? 📅",
      casual: "Ei {name}, chamada de 15 minutos esta semana? Podemos conversar sobre atrair mais clientes para seu {niche} em {city}. Você escolhe o dia.",
      luxury: "Prezado/a {name}, adoraríamos organizar uma consulta privada de 15 minutos para explorar como elevar seu {niche} em {city}.",
      aggressive: "{name}, reserve uma chamada de 15 minutos ESTA SEMANA. Mostro exatamente como dominar {city} como {niche}. Sem enrolação, só resultados. Responda com seu melhor horário.",
    },
  },
  ms: {
    booking: {
      professional: "Hai {name}, kami membantu {niche} di {city} mendapatkan lebih banyak tempahan dengan sistem pintar. Ada 10 minit untuk panggilan? Balas YA.",
      friendly: "Hai {name}! 👋 Kami membantu {niche} di {city} mendapatkan lebih banyak pelanggan dengan mudah. Nak panggilan 10 minit? Balas YA!",
      casual: "Hai {name}, soalan cepat — kami bantu {niche} di {city} tempah lebih ramai pelanggan. Ada 10 minit? Balas YA ✌️",
      luxury: "Hai {name}, kami mengangkat {niche} di {city} dengan penyelesaian teknologi yang dibuat khas. Boleh kita atur temu janji?",
      aggressive: "{name}, pesaing anda di {city} sudah guna sistem pintar untuk curi pelanggan anda. Hubungi SEKARANG sebelum rugi lagi. Balas YA.",
    },
    demo: {
      professional: "Hai {name}, saya jumpa {niche} anda di {city}. Saya ingin tunjuk dalam 15 minit bagaimana sistem kami bawa lebih banyak permintaan. Ada masa?",
      friendly: "Hai {name}! Saya jumpa {niche} anda di {city} dan ingin tunjuk macam mana kami tarik lebih ramai pelanggan. Berminat? 😊",
      casual: "Hai {name}, nampak {niche} anda di {city} — demo kami best dan ambil masa 15 min. Nak tengok?",
      luxury: "Hai {name}, kami terhormat untuk tunjukkan persembahan eksklusif untuk {niche} anda di {city}. Boleh kita atur sesi?",
      aggressive: "{name}, berhenti teka-teki dengan {niche} anda di {city}. Tengok demo kami dan nampak berapa ramai pelanggan anda dapat dalam 30 hari. Tempah sekarang.",
    },
    followup: {
      professional: "Hai {name}, saya susuli semula tentang penyelesaian pintar untuk {niche} di {city}. Sebarang soalan?",
      friendly: "Hai {name}, saya kembali semula! 😊 Ada idea macam mana kami boleh bantu {niche} anda di {city} berkembang?",
      casual: "Hai {name}, saya naikkan ini semula dalam peti masuk anda. Masih berminat kembangkan {niche} anda di {city}? Tak ada tekanan!",
      luxury: "Hai {name}, saya ingin mengetahui perkembangan tentang meningkatkan {niche} anda di {city}. Macam mana kami boleh bantu lebih lanjut?",
      aggressive: "{name}, saya tak dengar apa-apa. {niche} anda di {city} kehilangan pelanggan setiap hari anda tunggu. Mari bercakap — balas sekarang.",
    },
    offer: {
      professional: "Hai {name}, tawaran eksklusif untuk {niche} di {city}: 50 peratus diskaun bulan pertama. Masa terhad. Balas BERMINAT.",
      friendly: "Hai {name}! 🎉 Tawaran istimewa hanya untuk {niche} di {city}: 50 peratus diskaun bulan pertama! Balas BERMINAT untuk ambil.",
      casual: "Hai {name}, untuk makluman — {niche} di {city} dapat 50 peratus diskaun bulan pertama sekarang. Tawaran baik. Balas BERMINAT kalau nak masuk.",
      luxury: "Hai {name}, sebagai {niche} terkemuka di {city}, kami jemput anda secara eksklusif: 50 peratus diskaun bulan pertama. Balas BERMINAT.",
      aggressive: "{name}, pesaing anda di {city} sudah ambil tawaran 50 peratus ini. Tinggal beberapa tempat sahaja. Balas BERMINAT sebelum habis.",
    },
    meeting: {
      professional: "Hai {name}, ada 15 minit minggu ini untuk bincang bagaimana sistem pintar bantu {niche} anda di {city} tarik lebih ramai pelanggan?",
      friendly: "Hai {name}! Nak panggilan 15 minit minggu ini untuk bincang pertumbuhan {niche} anda di {city}? Hari mana sesuai? 📅",
      casual: "Hai {name}, panggilan 15 minit minggu ini? Boleh bincang cara tarik lebih ramai pelanggan untuk {niche} anda di {city}. Anda pilih hari.",
      luxury: "Hai {name}, kami gembira untuk atur perundingan peribadi 15 minit untuk terokai macam mana kami angkat {niche} anda di {city}.",
      aggressive: "{name}, tempah panggilan 15 minit MINGGU INI. Saya tunjuk tepat macam mana anda dominasi {city} sebagai {niche}. Takde main-main, hanya keputusan. Balas dengan masa terbaik anda.",
    },
  },
  id: {
    booking: {
      professional: "Halo {name}, kami membantu {niche} di {city} mendapatkan lebih banyak janji temu dengan sistem cerdas. Ada 10 menit untuk telepon? Balas YA.",
      friendly: "Halo {name}! 👋 Kami membantu {niche} di {city} mendapatkan lebih banyak pelanggan dengan mudah. Mau telepon 10 menit? Balas YA!",
      casual: "Halo {name}, pertanyaan cepat — kami bantu {niche} di {city} pesan lebih banyak pelanggan. Ada 10 menit? Balas YA ✌️",
      luxury: "Halo {name}, kami mengangkat {niche} di {city} dengan solusi teknologi yang dibuat khusus. Bisa kita atur pertemuan?",
      aggressive: "{name}, pesaing Anda di {city} sudah pakai sistem cerdas untuk curi pelanggan Anda. Hubungi SEKARANG sebelum rugi lagi. Balas YA.",
    },
    demo: {
      professional: "Halo {name}, saya menemukan {niche} Anda di {city}. Saya ingin menunjukkan dalam 15 menit bagaimana sistem kami bawa lebih banyak permintaan. Ada waktu?",
      friendly: "Halo {name}! Saya menemukan {niche} Anda di {city} dan ingin tunjukkan bagaimana kami tarik lebih banyak pelanggan. Tertarik? 😊",
      casual: "Halo {name}, lihat {niche} Anda di {city} — demo kami keren dan cuma 15 menit. Mau lihat?",
      luxury: "Halo {name}, kami terhormat untuk menunjukkan presentasi eksklusif untuk {niche} Anda di {city}. Bisa kita atur sesi?",
      aggressive: "{name}, berhenti menebak-nebak dengan {niche} Anda di {city}. Lihat demo kami dan lihat berapa banyak pelanggan Anda dapat dalam 30 hari. Pesan sekarang.",
    },
    followup: {
      professional: "Halo {name}, saya menindaklanjuti tentang solusi cerdas untuk {niche} Anda di {city}. Ada pertanyaan?",
      friendly: "Halo {name}, saya kembali lagi! 😊 Ada ide bagaimana kami bisa bantu {niche} Anda di {city} berkembang?",
      casual: "Halo {name}, saya angkat ini lagi ke kotak masuk Anda. Masih tertarik kembangkan {niche} Anda di {city}? Tanpa tekanan!",
      luxury: "Halo {name}, saya ingin mengetahui perkembangan tentang meningkatkan {niche} Anda di {city}. Bagaimana kami bisa bantu lebih lanjut?",
      aggressive: "{name}, saya tidak terima jawaban. {niche} Anda di {city} kehilangan pelanggan setiap hari Anda tunggu. Mari bicara — balas sekarang.",
    },
    offer: {
      professional: "Halo {name}, penawaran eksklusif untuk {niche} di {city}: diskon 50 persen bulan pertama. Waktu terbatas. Balas TERTARIK.",
      friendly: "Halo {name}! 🎉 Penawaran spesial hanya untuk {niche} di {city}: diskon 50 persen bulan pertama! Balas TERTARIK untuk ambil.",
      casual: "Halo {name}, info — {niche} di {city} dapat diskon 50 persen bulan pertama sekarang. Penawaran bagus. Balas TERTARIK kalau mau ikut.",
      luxury: "Halo {name}, sebagai {niche} terkemuka di {city}, kami undang Anda secara eksklusif: diskon 50 persen bulan pertama. Balas TERTARIK.",
      aggressive: "{name}, pesaing Anda di {city} sudah ambil penawaran diskon 50 persen ini. Tinggal beberapa tempat. Balas TERTARIK sebelum habis.",
    },
    meeting: {
      professional: "Halo {name}, ada 15 menit minggu ini untuk membahas bagaimana sistem cerdas bantu {niche} Anda di {city} tarik lebih banyak pelanggan?",
      friendly: "Halo {name}! Mau telepon 15 menit minggu ini untuk membahas pertumbuhan {niche} Anda di {city}? Hari mana yang cocok? 📅",
      casual: "Halo {name}, telepon 15 menit minggu ini? Bisa bicara cara tarik lebih banyak pelanggan untuk {niche} Anda di {city}. Anda pilih hari.",
      luxury: "Halo {name}, kami senang mengatur konsultasi pribadi 15 menit untuk mengeksplorasi bagaimana kami angkat {niche} Anda di {city}.",
      aggressive: "{name}, pesan telepon 15 menit MINGGU INI. Saya tunjukkan tepat bagaimana Anda dominasi {city} sebagai {niche}. Tanpa basa-basi, hanya hasil. Balas dengan waktu terbaik Anda.",
    },
  },
  fil: {
    booking: {
      professional: "Kamusta {name}, tinutulungan namin ang {niche} sa {city} na makakuha ng mas maraming kliyente sa pamamagitan ng matalinong sistema. May 10 minuto ka para sa tawag? Sumagot ng Oo.",
      friendly: "Kamusta {name}! 👋 Tinutulungan namin ang {niche} sa {city} na makakuha ng mas maraming kliyente nang madali. Gusto mo bang mag-usap ng 10 minuto? Sumagot ng Oo!",
      casual: "Hoy {name}, mabilis na tanong — tinutulungan namin ang {niche} sa {city} na makakuha ng mas maraming kliyente. May 10 minuto ka? Sumagot ng Oo ✌️",
      luxury: "Magandang araw {name}, itinataas namin ang {niche} sa {city} sa pamamagitan ng mga solusyong teknolohiya na ginawa para sa iyo. Pwede ba nating ayusin?",
      aggressive: "{name}, ang iyong mga kakompetensya sa {city} ay gumagamit na ng matalinong sistema para nakawin ang iyong mga kliyente. Tumawag NGAYON bago ka pa matalo. Sumagot ng Oo.",
    },
    demo: {
      professional: "Kamusta {name}, nakita ko ang iyong {niche} sa {city}. Gusto kitang ipakita sa loob ng 15 minuto kung paano nagdadala ng mas maraming patanong ang aming sistema. May oras ka?",
      friendly: "Kamusta {name}! Nakita ko ang iyong {niche} sa {city} at gusto kitang ipakita kung paano kami nakakakuha ng mas maraming kliyente. Interesado ka? 😊",
      casual: "Hoy {name}, nakita ko ang iyong {niche} sa {city} — ang aming demo ay astig at umaabot lang ng 15 minuto. Gusto mo bang makita?",
      luxury: "Ginagalang na {name}, kami ay magiging karangalan na magpakita ng eksklusibong demonstrasyon para sa iyong {niche} sa {city}. Pwede ba nating ayusin?",
      aggressive: "{name}, tigilan mo na ang hula-hula sa iyong {niche} sa {city}. Panoorin ang aming demo at tingnan mo kung gaano karaming kliyente ang makukuha mo sa loob ng 30 araw. Tumawag ka na.",
    },
    followup: {
      professional: "Kamusta {name}, sumusunod ako muli tungkol sa matalinong solusyon para sa {niche} sa {city}. May tanong ka?",
      friendly: "Kamusta {name}, bumabalik ako! 😊 May ideya ka ba kung paano namin mapapalago ang iyong {niche} sa {city}?",
      casual: "Hoy {name}, inaangat ko ulit ito sa iyong mensahe. Interesado ka pa bang palaguin ang iyong {niche} sa {city}? Walang pilitan!",
      luxury: "Ginagalang na {name}, nais ko sanang malaman ang update tungkol sa pagpapabuti ng iyong {niche} sa {city}. Paano ka pa namin matutulungan?",
      aggressive: "{name}, wala akong natanggap na sagot. Ang iyong {niche} sa {city} ay nawawalan ng kliyente araw-araw na naghihintay ka. Mag-usap tayo — sumagot ka na.",
    },
    offer: {
      professional: "Kamusta {name}, eksklusibong alok para sa {niche} sa {city}: 50 porsiyentong diskwento sa unang buwan. May limitasyon sa oras. Sumagot ng INTERESADO.",
      friendly: "Kamusta {name}! 🎉 Espesyal na alok para lang sa {niche} sa {city}: 50 porsiyentong diskwento sa unang buwan! Sumagot ng INTERESADO para makuha mo.",
      casual: "Hoy {name}, para sa kaalaman mo — ang {niche} sa {city} ay may 50 porsiyentong diskwento sa unang buwan ngayon. Magandang alok ito. Sumagot ng INTERESADO kung gusto mong sumali.",
      luxury: "Ginagalang na {name}, bilang isang tanyag na {niche} sa {city}, inaanyayahan ka naming eksklusibo: 50 porsiyentong diskwento sa unang buwan. Sumagot ng INTERESADO.",
      aggressive: "{name}, ang iyong mga kakompetensya sa {city} ay nakakuha na ng alok na 50 porsiyento. Ilang puwesto na lang ang natitira. Sumagot ng INTERESADO bago maubos.",
    },
    meeting: {
      professional: "Kamusta {name}, may 15 minuto ka ba ngayong linggo para pag-usapan kung paano tumutulong ang matalinong sistema sa iyong {niche} sa {city} na makakuha ng mas maraming kliyente?",
      friendly: "Kamusta {name}! Gusto mo bang mag-usap ng 15 minuto ngayong linggo tungkol sa paglago ng iyong {niche} sa {city}? Anong araw ang ok sa iyo? 📅",
      casual: "Hoy {name}, usapan ng 15 minuto ngayong linggo? Pwede nating pag-usapan kung paano makakuha ng mas maraming kliyente para sa iyong {niche} sa {city}. Ikaw ang pipili ng araw.",
      luxury: "Ginagalang na {name}, kami ay magiging masaya na mag-ayos ng pribadong konsultasyon na 15 minuto upang tuklasin kung paano itaas ang iyong {niche} sa {city}.",
      aggressive: "{name}, tumawag ka para sa 15 minutong usapan NGAYONG LINGGO. Ipapakita ko sa iyo kung paano mo didominahan ang {city} bilang isang {niche}. Walang paligoy-ligoy, resulta lang. Sumagot sa iyong pinakamagandang oras.",
    },
  },
  bn: {
    booking: {
      professional: "হ্যালো {name}, আমরা {city}-এ আপনার {niche} ব্যবসার জন্য স্মার্ট পদ্ধতিতে আরও বেশি গ্রাহক আনতে সাহায্য করি। ১০ মিনিট কথা বলার সময় আছে? আগ্রহ থাকলে হ্যাঁ লিখে জবাব দিন।",
      friendly: "হ্যালো {name}! 👋 আমরা {city}-এ আপনার {niche} ব্যবসাকে আরও সহজে বড় করতে সাহায্য করি। ১০ মিনিট কথা বলবেন? হ্যাঁ লিখে জবাব দিন!",
      casual: "হ্যালো {name}, একটা ছোট প্রশ্ন — আমরা {city}-এ আপনার {niche} ব্যবসায় আরও বেশি অ্যাপয়েন্টমেন্ট জোগাড় করতে সাহায্য করি। ১০ মিনিট আছে? হ্যাঁ লিখুন ✌️",
      luxury: "প্রিয় {name}, আমরা {city}-এ আপনার {niche} ব্যবসাকে বিশেষ প্রযুক্তির মাধ্যমে নতুন উচ্চতায় নিয়ে যেতে চাই। একটি মিটিং সাজাতে পারি?",
      aggressive: "{name}, {city}-তে আপনার প্রতিযোগীরা ইতিমধ্যে স্মার্ট পদ্ধতি ব্যবহার করে আপনার গ্রাহক কেড়ে নিচ্ছে। আরও না হারিয়ে এখনই যোগাযোগ করুন। হ্যাঁ লিখে জবাব দিন।",
    },
    demo: {
      professional: "হ্যালো {name}, আমি {city}-তে আপনার {niche} ব্যবসা দেখেছি। আমাদের স্মার্ট পদ্ধতির কাজ ১৫ মিনিটে দেখাতে চাই। সময় আছে?",
      friendly: "হ্যালো {name}! আমি {city}-তে আপনার {niche} ব্যবসা দেখেছি এবং আরও বেশি গ্রাহক আনার উপায় দেখাতে চাই। আগ্রহী? 😊",
      casual: "হ্যালো {name}, {city}-তে আপনার {niche} ব্যবসা দেখলাম — আমাদের প্রদর্শনী বেশ মজার এবং মাত্র ১৫ মিনিট। দেখবেন?",
      luxury: "প্রিয় {name}, {city}-তে আপনার {niche} ব্যবসার জন্য একটি বিশেষ প্রদর্শনী দেখানো আমাদের সম্মান হবে। একটি বৈঠক সাজাতে পারি?",
      aggressive: "{name}, {city}-তে আপনার {niche} ব্যবসা নিয়ে আর অনুমান করবেন না। আমাদের প্রদর্শনী দেখুন এবং দেখুন ৩০ দিনে কত গ্রাহক পাবেন। এখনই বুক করুন।",
    },
    followup: {
      professional: "হ্যালো {name}, {city}-তে আপনার {niche} ব্যবসার জন্য স্মার্ট সমাধান নিয়ে আবার যোগাযোগ করছি। কোনো প্রশ্ন?",
      friendly: "হ্যালো {name}, আবার হাজির! 😊 {city}-তে আপনার {niche} ব্যবসা বড় করতে কোনো চিন্তা?",
      casual: "হ্যালো {name}, আবার ইনবক্সের উপরে তুলে দিলাম। {city}-তে আপনার {niche} ব্যবসা বড় করতে এখনো আগ্রহী? কোনো চাপ নেই!",
      luxury: "প্রিয় {name}, {city}-তে আপনার {niche} ব্যবসা উন্নত করার বিষয়ে খোঁজখবর নিতে চাই। আরও কীভাবে সাহায্য করতে পারি?",
      aggressive: "{name}, কোনো জবাব পাইনি। {city}-তে আপনার {niche} ব্যবসা প্রতিদিন গ্রাহক হারাচ্ছে। কথা বলুন — এখনই জবাব দিন।",
    },
    offer: {
      professional: "হ্যালো {name}, {city}-তে আপনার {niche} ব্যবসার জন্য বিশেষ অফার: প্রথম মাসে ৫০ শতাংশ ছাড়। সীমিত সময়। আগ্রহ থাকলে আগ্রহী লিখে জবাব দিন।",
      friendly: "হ্যালো {name}! 🎉 {city}-তে আপনার {niche} ব্যবসার জন্য বিশেষ ডিল: প্রথম মাসে ৫০ শতাংশ ছাড়! আগ্রহী লিখে জবাব দিন।",
      casual: "হ্যালো {name}, জানিয়ে রাখি — {city}-তে {niche} ব্যবসা এখন প্রথম মাসে ৫০ শতাংশ ছাড় পাচ্ছে। দারুণ ডিল। আগ্রহী লিখুন যদি নিতে চান।",
      luxury: "প্রিয় {name}, {city}-তে একজন বিশিষ্ট {niche} ব্যবসায়ী হিসেবে আমরা আপনাকে বিশেষভাবে আমন্ত্রণ জানাই: প্রথম মাসে ৫০ শতাংশ ছাড়। আগ্রহী লিখে জবাব দিন।",
      aggressive: "{name}, {city}-তে আপনার প্রতিযোগীরা ইতিমধ্যে এই ৫০ শতাংশ ছাড় নিয়ে নিয়েছে। আর কয়েকটা সীট বাকি। আগ্রহী লিখে জবাব দিন।",
    },
    meeting: {
      professional: "হ্যালো {name}, এই সপ্তাহে ১৫ মিনিট সময় আছে {city}-তে আপনার {niche} ব্যবসায় আরও বেশি গ্রাহক আনার উপায় নিয়ে কথা বলার?",
      friendly: "হ্যালো {name}! এই সপ্তাহে ১৫ মিনিট কথা বলবেন {city}-তে আপনার {niche} ব্যবসা নিয়ে? কোন দিন হবে? 📅",
      casual: "হ্যালো {name}, এই সপ্তাহে ১৫ মিনিট ফোন? {city}-তে আপনার {niche} ব্যবসায় আরও গ্রাহক আনার কথা হবে। দিনটি আপনি বাছুন।",
      luxury: "প্রিয় {name}, {city}-তে আপনার {niche} ব্যবসা উন্নত করার উপায় নিয়ে ১৫ মিনিটের একটি ব্যক্তিগত পরামর্শ সাজাতে পারলে আমরা খুশি হব।",
      aggressive: "{name}, এই সপ্তাহে ১৫ মিনিটের কল বুক করুন। ঠিক দেখিয়ে দেব কীভাবে {city}-তে {niche} হিসেবে আপনি সবার উপরে উঠবেন। শুধু ফলাফল। জবাব দিন আপনার সেরা সময় দিয়ে।",
    },
  },
  ur: {
    booking: {
      professional: "السلام علیکم {name}، ہم {city} میں آپ کے {niche} کاروبار کے لیے مزید گاہک لانے میں مدد کرتے ہیں۔ کیا 10 منٹ بات کرنے کا وقت ہے؟ دلچسپی ہو تو ہاں لکھ کر جواب دیں۔",
      friendly: "السلام علیکم {name}! 👋 ہم {city} میں آپ کے {niche} کاروبار کو آسان طریقے سے بڑھنے میں مدد کرتے ہیں۔ 10 منٹ بات کریں گے؟ ہاں لکھ کر جواب دیں!",
      casual: "ہیلو {name}، ایک چھوٹا سوال — ہم {city} میں آپ کے {niche} کاروبار میں مزید اپوائنٹمنٹس دلانے میں مدد کرتے ہیں۔ کیا 10 منٹ ہیں؟ ہاں لکھیں ✌️",
      luxury: "محترم {name}، ہم {city} میں آپ کے {niche} کاروبار کو خاص تکنیک کے ذریعے نئی بلندیوں تک لے جانا چاہتے ہیں۔ کیا ایک ملاقات طے کر سکتے ہیں؟",
      aggressive: "{name}، {city} میں آپ کے حریف پہلے سے ہی سمارٹ طریقے استعمال کر کے آپ کے گاہک چرا رہے ہیں۔ مزید نہ ہاریں، ابھی رابطہ کریں۔ ہاں لکھ کر جواب دیں۔",
    },
    demo: {
      professional: "السلام علیکم {name}، میں نے {city} میں آپ کا {niche} کاروبار دیکھا۔ میں آپ کو 15 منٹ میں ہمارے سمارٹ طریقے کا کام دکھانا چاہتا ہوں۔ کیا وقت ہے؟",
      friendly: "السلام علیکم {name}! میں نے {city} میں آپ کا {niche} کاروبار دیکھا اور مزید گاہک لانے کا طریقہ دکھانا چاہتا ہوں۔ دلچسپی ہے؟ 😊",
      casual: "ہیلو {name}، {city} میں آپ کا {niche} کاروبار دیکھا — ہمارا ڈیمو کافی دلچسپ ہے اور صرف 15 منٹ کا ہے۔ دیکھنا چاہیں گے؟",
      luxury: "محترم {name}، {city} میں آپ کے {niche} کاروبار کے لیے ایک خاص ڈیمو دکھانا ہمارے لیے باعث فخر ہو گا۔ کیا ایک نشست طے کر سکتے ہیں؟",
      aggressive: "{name}، {city} میں اپنے {niche} کاروبار کے بارے میں مزید اندازے نہیں لگائیں۔ ہمارا ڈیمو دیکھیں اور دیکھیں کہ 30 دنوں میں کتنے گاہک ملیں گے۔ ابھی بک کریں۔",
    },
    followup: {
      professional: "السلام علیکم {name}، {city} میں آپ کے {niche} کاروبار کے لیے سمارٹ حل کے بارے میں دوبارہ رابطہ کر رہا ہوں۔ کوئی سوال؟",
      friendly: "السلام علیکم {name}، واپس آیا ہوں! 😊 {city} میں آپ کے {niche} کاروبار کو بڑھانے کے بارے میں کوئی خیال؟",
      casual: "ہیلو {name}، اسے دوبارہ انباکس کے اوپر لا رہا ہوں۔ {city} میں اپنے {niche} کاروبار کو بڑھانے میں ابھی بھی دلچسپی ہے؟ کوئی دباؤ نہیں!",
      luxury: "محترم {name}، {city} میں آپ کے {niche} کاروبار کو بہتر بنانے کے بارے میں خیریت دریافت کرنا چاہتا ہوں۔ مزید کیسے مدد کر سکتے ہیں؟",
      aggressive: "{name}، کوئی جواب نہیں ملا۔ {city} میں آپ کا {niche} کاروبار ہر دن گاہک کھو رہا ہے۔ بات کریں — ابھی جواب دیں۔",
    },
    offer: {
      professional: "السلام علیکم {name}، {city} میں آپ کے {niche} کاروبار کے لیے خصوصی پیش کش: پہلے مہینے 50 فیصد رعایت۔ محدود وقت۔ دلچسپی لکھ کر جواب دیں۔",
      friendly: "السلام علیکم {name}! 🎉 {city} میں آپ کے {niche} کاروبار کے لیے خاص ڈیل: پہلے مہینے 50 فیصد رعایت! دلچسپی لکھ کر جواب دیں۔",
      casual: "ہیلو {name}، آگاہی کے لیے — {city} میں {niche} کاروبار کو اب پہلے مہینے 50 فیصد رعایت مل رہی ہے۔ زبردست ڈیل۔ دلچسپی لکھیں اگر لینا چاہیں۔",
      luxury: "محترم {name}، {city} میں ایک معزز {niche} کاروبار کے طور پر ہم آپ کو خصوصی طور پر مدعو کرتے ہیں: پہلے مہینے 50 فیصد رعایت۔ دلچسپی لکھ کر جواب دیں۔",
      aggressive: "{name}، {city} میں آپ کے حریف پہلے سے ہی یہ 50 فیصد رعایت لے چکے ہیں۔ چند سیٹس باقی ہیں۔ دلچسپی لکھ کر جواب دیں۔",
    },
    meeting: {
      professional: "السلام علیکم {name}، کیا اس ہفتے 15 منٹ کا وقت ہے {city} میں آپ کے {niche} کاروبار میں مزید گاہک لانے کے طریقے پر بات کرنے کا؟",
      friendly: "السلام علیکم {name}! کیا اس ہفتے 15 منٹ بات کریں گے {city} میں آپ کے {niche} کاروبار کے بارے میں؟ کون سا دن مناسب ہے؟ 📅",
      casual: "ہیلو {name}، اس ہفتے 15 منٹ کا فون؟ {city} میں آپ کے {niche} کاروبار میں مزید گاہک لانے پر بات ہوگی۔ دن آپ منتخب کریں۔",
      luxury: "محترم {name}، {city} میں آپ کے {niche} کاروبار کو بلندی تک لے جانے کے طریقوں پر 15 منٹ کی نجی مشاورت طے کرنے میں ہم خوش ہوں گے۔",
      aggressive: "{name}، اس ہفتے 15 منٹ کا کال بک کریں۔ بالکل دکھاؤں گا کہ {city} میں {niche} کے طور پر آپ کیسے سب پر غالب آئیں گے۔ صرف نتائج۔ اپنا بہترین وقت لکھ کر جواب دیں۔",
    },
  },
};

const LENGTH_MODIFIERS: Record<string, Record<string, (msg: string) => string>> = {
  en: {
    short: (msg) => msg.split('.').slice(0, 2).join('.') + '.',
    medium: (msg) => msg,
    long: (msg) => msg + ' Looking forward to hearing from you soon.',
  },
  de: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Ich freue mich auf Ihre Rückmeldung.' },
  fr: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Au plaisir de vous lire.' },
  es: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Quedo a la espera de su respuesta.' },
  it: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' In attesa di un suo riscontro.' },
  nl: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Ik kijk uit naar uw reactie.' },
  pt: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Aguardo sua resposta.' },
  ms: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Kami menanti jawapan anda.' },
  id: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Kami menunggu balasan Anda.' },
  fil: { short: (msg) => msg.split('.').slice(0, 2).join('.') + '.', medium: (msg) => msg, long: (msg) => msg + ' Inaasahan namin ang inyong sagot.' },
  bn: { short: (msg) => msg.split('।').slice(0, 2).join('।') + '।', medium: (msg) => msg, long: (msg) => msg + ' আপনার জবাবের অপেক্ষায় রইলাম।' },
  ur: { short: (msg) => msg.split('۔').slice(0, 2).join('۔') + '۔', medium: (msg) => msg, long: (msg) => msg + ' آپ کے جواب کا منتظر رہوں گا۔' },
};

function generateAIMessage(
  businessType: string,
  goal: string,
  language: string,
  tone: string,
  length: string,
  writingStyle: string,
  leadName?: string,
  leadCity?: string
): string {
  const useNative = writingStyle !== 'translated';
  const langKey = useNative ? (LANG_TEMPLATES[language] ? language : 'en') : 'en';
  const lang = LANG_TEMPLATES[langKey] || LANG_TEMPLATES.en;
  const goalSet = lang[goal] || lang.booking;
  const tmpl = goalSet[tone] || goalSet.professional || Object.values(goalSet)[0];

  // Translate business type for native mode if available
  let nicheLabel = businessType || '{niche}';
  if (useNative && language !== 'en') {
    const labels = NICHE_LABELS[language] || {};
    const raw = businessType.toLowerCase().trim();
    // Try multiple normalization strategies for robust matching
    const keys = [
      raw.replace(/\s+/g, ''),           // "home renovation" → "homerenovation"
      raw.replace(/[^a-z0-9\u0080-\uFFFF]/g, '').replace(/\s+/g, ''), // alphanumeric compact
      raw.split(/\s+/)[0],              // first word fallback
      raw.replace(/\s+/g, '-'),         // hyphenated
    ];
    for (const k of keys) {
      if (labels[k]) { nicheLabel = labels[k]; break; }
    }
  }

  let msg = tmpl
    .replace(/\{name\}/g, leadName || '{name}')
    .replace(/\{city\}/g, leadCity || '{city}')
    .replace(/\{niche\}/g, nicheLabel);
  const modSet = LENGTH_MODIFIERS[langKey] || LENGTH_MODIFIERS.en;
  const modifier = modSet[length] || modSet.medium;
  return modifier(msg);
}

type WaTab = 'connect' | 'account' | 'campaigns' | 'composer' | 'conversations' | 'automation' | 'settings' | 'logs';

const WA_TABS: Array<{ id: WaTab; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'account', label: 'Account' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'composer', label: 'Composer' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'automation', label: 'Automation' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Logs' },
];

export default function WhatsAppPage() {
  const [tab, setTab] = useState<WaTab>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const q = String(params.get('tab') || '').toLowerCase();
      const allowed: WaTab[] = ['connect', 'account', 'campaigns', 'composer', 'automation', 'conversations', 'settings', 'logs'];
      if ((allowed as string[]).includes(q)) return q as WaTab;
      // Contacts / leads handoff → land on Composer with selection ready
      if (getTransferredLeadsForChannel('whatsapp').length > 0) return 'composer';
    } catch { /* ignore */ }
    return 'connect';
  });
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [credInfo, setCredInfo] = useState<WhatsAppCredentialsInfo | null>(null);
  const [workspace, setWorkspace] = useState<WhatsAppWorkspaceResponse | null>(null);
  const [liveStats, setLiveStats] = useState<WhatsAppLiveStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [scores, setScores] = useState<ScoredLead[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [campaignStats, setCampaignStats] = useState<CampaignStats | null>(null);
  const [pipelineFilter, setPipelineFilter] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const [s, w, st] = await Promise.all([
        getWhatsAppStatus(),
        getWhatsAppWorkspace().catch(() => null),
        getWhatsAppLiveStats().catch(() => null),
      ]);
      setStatus(s);
      setCredInfo({
        configured: Boolean(s?.connected || s?.configured),
        connected: Boolean(s?.connected),
        status: s?.status,
        transport: 'meta',
        phone: s?.phone || null,
        hasToken: Boolean(s?.hasToken),
        hasPhoneNumberId: Boolean(s?.hasPhoneNumberId),
        phoneNumberId: null,
      });
      if (w) setWorkspace(w);
      if (st?.stats) setLiveStats(st.stats);
    } catch {
      setStatus({ configured: false } as WhatsAppStatus);
      setCredInfo(null);
    }
  }, []);

  const refreshCampaigns = useCallback(async () => {
    try {
      const [statsRes, campsRes] = await Promise.all([getCampaignStats(), getCampaigns()]);
      setCampaignStats(statsRes?.stats ?? null);
      setCampaigns(campsRes?.campaigns ?? []);
    } catch (e) {
      console.error('[WhatsApp] Failed to refresh campaigns:', e);
    }
  }, []);

  const reloadRecipients = useCallback(async () => {
    setLeads(getTransferredLeadsForChannel('whatsapp'));
    await refreshCampaigns();
    await refreshStatus();
  }, [refreshCampaigns, refreshStatus]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const transferredLeads = getTransferredLeadsForChannel('whatsapp');
        const hasRecipients = transferredLeads.length > 0;
        const fromContacts = isContactsSource('whatsapp');
        const [s, w, st, scoresRes] = await Promise.all([
          getWhatsAppStatus(),
          getWhatsAppWorkspace().catch(() => null),
          getWhatsAppLiveStats().catch(() => null),
          hasRecipients && !fromContacts ? getScores() : Promise.resolve({ scores: [] }),
        ]);
        if (!active) return;
        setStatus(s);
        setCredInfo({
          configured: Boolean(s?.connected || s?.configured),
          connected: Boolean(s?.connected),
          status: s?.status,
          transport: 'meta',
          phone: s?.phone || null,
          hasToken: Boolean(s?.hasToken),
          hasPhoneNumberId: Boolean(s?.hasPhoneNumberId),
          phoneNumberId: null,
        });
        if (w) setWorkspace(w);
        if (st?.stats) setLiveStats(st.stats);
        setLeads(transferredLeads);
        setScores(scoresRes?.scores ?? []);
      } catch {
        if (active) {
          setStatus({ configured: false } as WhatsAppStatus);
          setCredInfo(null);
        }
      }
      try {
        const [statsRes, campsRes] = await Promise.all([getCampaignStats(), getCampaigns()]);
        if (active) {
          setCampaignStats(statsRes?.stats ?? null);
          setCampaigns(campsRes?.campaigns ?? []);
        }
      } catch { /* optional */ }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  // Auto-refresh connection + live stats
  useEffect(() => {
    const id = window.setInterval(() => { void refreshStatus(); }, 12000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const configured = Boolean(status?.connected || status?.configured || workspace?.configured || workspace?.connectionStatus === 'connected');
  const conn = workspace?.connectionStatus || (configured ? 'connected' : 'disconnected');
  const displayPhone = workspace?.account?.displayPhoneNumber || '—';

  const stats = liveStats || {
    total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, responseRate: 0, successRate: 0,
  };

  const runControl = async (action: string, opts: { scheduledAt?: string; total?: number } = {}) => {
    setBusyAction(action);
    setActionMsg('');
    try {
      const res = await controlWhatsAppCampaign(action, opts);
      setActionMsg(`Campaign ${res.campaignJob.status}`);
      await refreshStatus();
    } catch (err) {
      setActionMsg(errMessage(err, 'Campaign control failed'));
    } finally {
      setBusyAction('');
    }
  };

  if (loading) {
    return (
      <div className="lf-page wa-page">
        <PageHeader title="WhatsApp Business" subtitle="Enterprise WhatsApp workspace" />
        <div className="lf-skeleton-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="lf-card lf-skeleton" />)}</div>
      </div>
    );
  }

  return (
    <div className="lf-page wa-page">
      <PageHeader
        title="WhatsApp Business"
        subtitle={`Meta WhatsApp Cloud API · ${displayPhone}`}
        actions={
          <span className={`wa-status-pill ${conn}`}>
            <span className="wa-dot" />
            {conn === 'connecting' ? 'Connecting…' : conn === 'connected' ? 'Connected' : 'Disconnected'}
          </span>
        }
      />

      <div className="wa-grid-stats">
        {[
          ['Total', stats.total, 'glow-cyan'],
          ['Queued', stats.queued, 'glow-orange'],
          ['Sent', stats.sent, 'glow-blue'],
          ['Delivered', stats.delivered, 'glow-green'],
          ['Read', stats.read, 'glow-purple'],
          ['Failed', stats.failed, 'glow-pink'],
          ['Replied', stats.replied, 'glow-green'],
          ['Response %', stats.responseRate, 'glow-cyan'],
          ['Success %', stats.successRate, 'glow-blue'],
          ['Deals', campaignStats?.byStatus?.deal ?? campaignStats?.deal ?? 0, 'glow-orange'],
        ].map(([label, value, glow]) => (
          <div key={String(label)} className={`wa-card ${glow}`}>
            <div className="wa-stat-value">{Number(value).toLocaleString()}{String(label).includes('%') ? '%' : ''}</div>
            <div className="wa-stat-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="wa-tabs">
        {WA_TABS.map((t) => (
          <button key={t.id} type="button" className={`wa-tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {actionMsg && <div className="lf-alert" style={{ marginBottom: 14 }}>{actionMsg}</div>}

      {tab === 'connect' && (
        <WaConnectPanel
          workspace={workspace}
          configured={configured}
          status={status}
          credInfo={credInfo}
          onRefresh={async () => { await refreshStatus(); }}
          onConnected={async () => { await refreshStatus(); setTab('account'); }}
        />
      )}

      {tab === 'account' && (
        <div className="wa-card glow-green">
          <h3 className="wa-section-title">WhatsApp Account</h3>
          <div className="wa-account-grid">
            {[
              ['Phone number', workspace?.account?.displayPhoneNumber || '—'],
              ['Display name', workspace?.account?.displayName || '—'],
              ['Display name status', workspace?.account?.displayNameStatus || '—'],
              ['Business name', workspace?.account?.businessName || '—'],
              ['Phone Number ID', workspace?.account?.phoneNumberId || '—'],
              ['WABA ID', workspace?.account?.wabaId || '—'],
              ['Quality rating', workspace?.account?.qualityRating || '—'],
              ['Messaging limit', workspace?.account?.messagingLimit || '—'],
              ['Token status', workspace?.tokenStatus || '—'],
              ['Last connected', workspace?.lastConnectedAt ? new Date(workspace.lastConnectedAt).toLocaleString() : '—'],
            ].map(([label, value]) => (
              <div key={label} className="wa-field">
                <label>{label}</label>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {workspace?.connectionError && (
            <div className="lf-alert lf-alert-error" style={{ marginTop: 14 }}>{workspace.connectionError}</div>
          )}
        </div>
      )}

      {tab === 'campaigns' && (
        <div className="wa-card glow-cyan" style={{ marginBottom: 18 }}>
          <h3 className="wa-section-title">Campaign Sending Controls</h3>
          <p className="wa-muted">Job status: <strong>{workspace?.campaignJob?.status || 'idle'}</strong>
            {workspace?.campaignJob?.scheduledAt ? ` · scheduled ${new Date(workspace.campaignJob.scheduledAt).toLocaleString()}` : ''}
            {typeof workspace?.campaignJob?.sent === 'number' ? ` · sent ${workspace.campaignJob.sent}/${workspace.campaignJob.total || 0}` : ''}
          </p>
          <div className="wa-actions">
            <button className="lf-btn lf-btn-primary" disabled={!!busyAction} onClick={async () => { await runControl('start', { total: leads.filter(hasPhone).length }); setTab('composer'); }}>Send immediately</button>
            <button className="lf-btn" disabled={!!busyAction} onClick={async () => { await runControl('schedule', { scheduledAt: new Date(Date.now() + 3600000).toISOString(), total: leads.filter(hasPhone).length }); setTab('composer'); }}>Schedule later (+1h)</button>
            <button className="lf-btn" disabled={!!busyAction} onClick={() => runControl('pause')}>Pause campaign</button>
            <button className="lf-btn" disabled={!!busyAction} onClick={() => runControl('resume')}>Resume campaign</button>
            <button className="lf-btn" disabled={!!busyAction} onClick={() => runControl('cancel')}>Cancel campaign</button>
            <button className="lf-btn" onClick={() => setTab('composer')}>Composer / test message</button>
          </div>
          <div style={{ marginTop: 18 }}>
            <SalesPipeline
              byStatus={campaignStats?.byStatus || null}
              onStageClick={setPipelineFilter}
              activeFilter={pipelineFilter}
              entityLabel={isContactsSource('whatsapp') ? 'Contact' : 'Lead'}
            />
          </div>
        </div>
      )}

      {(tab === 'campaigns' || tab === 'composer') && (
        <>
          {tab === 'composer' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              <WaAiComposer />
              <CampaignAnalytics
                total={leads.length}
                withPhone={leads.filter(hasPhone).length}
                sent={stats.sent}
                replies={stats.replied}
                followUpsSent={campaignStats?.followUpsPending ?? 0}
                meetings={campaignStats?.byStatus?.meeting ?? 0}
                deals={campaignStats?.byStatus?.deal ?? campaignStats?.deal ?? 0}
                entityLabel={isContactsSource('whatsapp') ? 'Contacts' : 'Leads'}
              />
            </div>
          )}
          <ComposeCard
            configured={configured}
            leads={leads}
            scores={scores}
            campaigns={campaigns}
            onCampaignChange={reloadRecipients}
            pipelineFilter={pipelineFilter}
            onClearFilter={() => setPipelineFilter(null)}
          />
        </>
      )}

      {tab === 'conversations' && <WaConversationsPanel />}

      {tab === 'automation' && <WaAutomationPanel onOpenChat={() => setTab('conversations')} />}

      {tab === 'settings' && (
        <div className="wa-card glow-blue">
          <h3 className="wa-section-title">Settings</h3>
          <div className="wa-account-grid" style={{ marginBottom: 16 }}>
            <div className="wa-field"><label>Transport</label><strong>Meta Cloud API (official)</strong></div>
            <div className="wa-field"><label>Phone number</label><strong>{workspace?.account?.displayPhoneNumber || '—'}</strong></div>
            <div className="wa-field"><label>Connection</label><strong>{workspace?.connectionStatus || '—'}</strong></div>
            <div className="wa-field"><label>Webhook verify token</label><strong>{workspace?.webhook?.verifyTokenConfigured ? 'Configured' : 'Not set (WHATSAPP_WEBHOOK_VERIFY_TOKEN)'}</strong></div>
            <div className="wa-field"><label>Webhook signature</label><strong>{workspace?.webhook?.signatureSecretConfigured ? 'Configured' : 'Not set (WHATSAPP_APP_SECRET)'}</strong></div>
            <div className="wa-field"><label>Auto Reply</label><strong>Managed per conversation in Inbox</strong></div>
          </div>
          <p className="wa-muted" style={{ marginBottom: 12 }}>
            Manage Meta Cloud API credentials in the Connect tab. Auto Reply is toggled on each WhatsApp conversation in Inbox (same as Email).
          </p>
          <div className="wa-actions">
            <button
              className="lf-btn lf-btn-primary"
              type="button"
              onClick={async () => {
                setBusyAction('test');
                try {
                  const res = await testWhatsAppConnection();
                  setActionMsg(res.valid ? 'Connection test passed' : (res.error || 'Connection test failed'));
                  await refreshStatus();
                } catch (err) {
                  setActionMsg(errMessage(err, 'Connection test failed'));
                } finally {
                  setBusyAction('');
                }
              }}
            >
              {busyAction === 'test' ? 'Testing…' : 'Connection test'}
            </button>
            <button className="lf-btn" type="button" onClick={() => setTab('connect')}>Open Connect</button>
          </div>
        </div>
      )}

      {tab === 'logs' && <WaLogsPanel />}
    </div>
  );
}

function WaConnectPanel({
  workspace, configured, onRefresh, onConnected,
}: {
  workspace: WhatsAppWorkspaceResponse | null;
  configured: boolean;
  status: WhatsAppStatus | null;
  credInfo: WhatsAppCredentialsInfo | null;
  onRefresh: () => Promise<void>;
  onConnected: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const conn = workspace?.connectionStatus || (configured ? 'connected' : 'disconnected');
  const account = workspace?.account;
  const webhook = workspace?.webhook;

  const save = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      if (!token.trim() || !phoneNumberId.trim()) {
        throw new Error('Access Token and Phone Number ID are required');
      }
      const validation = await validateWhatsAppCredentials({
        token: token.trim(),
        phoneNumberId: phoneNumberId.trim(),
        wabaId: wabaId.trim() || undefined,
      });
      if (!validation.valid) {
        throw new Error(validation.error || 'Meta rejected these credentials');
      }
      await saveWhatsAppCredentials({
        token: token.trim(),
        phoneNumberId: phoneNumberId.trim(),
        wabaId: wabaId.trim() || undefined,
      });
      setToken('');
      setPhoneNumberId('');
      setWabaId('');
      setNotice('Credentials validated and saved. WhatsApp Cloud API is connected.');
      await onConnected();
    } catch (err) {
      setError(errMessage(err, 'Failed to save credentials'));
    } finally {
      setBusy('');
    }
  };

  const test = async () => {
    setBusy('test');
    setError('');
    setNotice('');
    try {
      const res = await testWhatsAppConnection();
      if (res.valid) {
        setNotice(`Connection OK — ${res.displayPhoneNumber || res.verifiedName || 'Meta account verified'}`);
      } else {
        setError(res.error || 'Connection test failed');
      }
      await onRefresh();
    } catch (err) {
      setError(errMessage(err, 'Connection test failed'));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setError('');
    setNotice('');
    try {
      await deleteWhatsAppCredentials();
      setNotice('Credentials removed. WhatsApp is disconnected.');
      await onRefresh();
    } catch (err) {
      setError(errMessage(err, 'Failed to disconnect'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="wa-connect-layout">
      <div className="wa-card glow-green">
        <h3 className="wa-section-title">Connection Status</h3>
        <span className={`wa-status-pill ${conn === 'error' ? 'disconnected' : conn}`}>
          <span className="wa-dot" />
          {conn === 'connected' ? 'Connected' : conn === 'error' ? 'Credential error' : 'Disconnected'}
        </span>
        <div className="wa-account-grid" style={{ marginTop: 14 }}>
          {[
            ['Phone number', account?.displayPhoneNumber || '—'],
            ['Business name', account?.businessName || account?.displayName || '—'],
            ['Display name status', account?.displayNameStatus || '—'],
            ['Phone Number ID', account?.phoneNumberId || '—'],
            ['WABA ID', account?.wabaId || '—'],
            ['Token status', workspace?.tokenStatus || 'not_configured'],
            ['Credential source', workspace?.credentialSource || '—'],
            ['Webhook verify token', webhook?.verifyTokenConfigured ? 'Configured' : 'Not set'],
            ['Webhook signature', webhook?.signatureSecretConfigured ? 'Configured' : 'Not set'],
          ].map(([label, value]) => (
            <div key={label} className="wa-field"><label>{label}</label><strong>{value}</strong></div>
          ))}
        </div>
        <div className="wa-actions" style={{ marginTop: 14 }}>
          <button className="lf-btn" type="button" disabled={!!busy || !configured} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button className="lf-btn" type="button" disabled={!!busy} onClick={() => void onRefresh()}>
            Refresh status
          </button>
          <button className="lf-btn" type="button" disabled={!!busy || !configured} onClick={() => void disconnect()}>
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
        {(error || workspace?.connectionError) && (
          <div className="lf-alert lf-alert-error" style={{ marginTop: 10 }}>{error || workspace?.connectionError}</div>
        )}
        {notice && <div className="lf-alert" style={{ marginTop: 10 }}>{notice}</div>}
      </div>

      <div className="wa-card glow-cyan">
        <h3 className="wa-section-title">Meta Cloud API Credentials</h3>
        <p className="wa-muted" style={{ marginBottom: 12 }}>
          From Meta App Dashboard → WhatsApp → API Setup. Alternatively set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_WABA_ID environment variables on the server.
        </p>
        <div className="wa-field" style={{ marginBottom: 10 }}>
          <label>Access Token (permanent)</label>
          <input
            className="lf-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAA…"
            autoComplete="off"
          />
        </div>
        <div className="wa-field" style={{ marginBottom: 10 }}>
          <label>Phone Number ID</label>
          <input
            className="lf-input"
            type="text"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder="e.g. 123456789012345"
            autoComplete="off"
          />
        </div>
        <div className="wa-field" style={{ marginBottom: 12 }}>
          <label>WABA ID (optional — enables templates)</label>
          <input
            className="lf-input"
            type="text"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
            placeholder="WhatsApp Business Account ID"
            autoComplete="off"
          />
        </div>
        <div className="wa-actions">
          <button className="lf-btn lf-btn-primary" type="button" disabled={!!busy} onClick={() => void save()}>
            {busy === 'save' ? 'Validating…' : 'Validate & Save'}
          </button>
        </div>
        <p className="wa-muted" style={{ marginTop: 12 }}>
          Webhook: subscribe <strong>/api/whatsapp/webhook</strong> in Meta App Dashboard (fields: messages) with your verify token. Incoming replies appear in the Inbox; delivery and read receipts update automatically.
        </p>
      </div>
    </div>
  );
}

function WaAiComposer() {
  const [text, setText] = useState('');
  const [tone, setTone] = useState('professional');
  const [language, setLanguage] = useState('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (action: 'write' | 'rewrite' | 'translate') => {
    setBusy(true); setError('');
    try {
      const res = await whatsAppAiCompose({ action, text, tone, language, businessType: 'business', goal: 'booking' });
      setText(res.message || '');
    } catch (err) {
      setError(errMessage(err, 'AI compose failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wa-card glow-purple">
      <h3 className="wa-section-title">AI Message Studio</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <select className="lf-input" value={tone} onChange={(e) => setTone(e.target.value)}>
          {['professional', 'friendly', 'persuasive', 'casual'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="lf-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
          {['en', 'ms', 'zh', 'ta', 'hi', 'ar', 'es', 'fr'].map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <textarea className="lf-textarea" style={{ minHeight: 120 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="AI will write / rewrite / translate here. Supports {name} {city} {niche}" />
      <div className="wa-actions">
        <button className="lf-btn lf-btn-primary" disabled={busy} onClick={() => run('write')}>AI write</button>
        <button className="lf-btn" disabled={busy || !text.trim()} onClick={() => run('rewrite')}>AI rewrite</button>
        <button className="lf-btn" disabled={busy || !text.trim()} onClick={() => run('translate')}>AI translate</button>
      </div>
      {error && <div className="lf-alert lf-alert-error" style={{ marginTop: 10 }}>{error}</div>}
      <div style={{ marginTop: 14 }}><AiMessageGenerator /></div>
    </div>
  );
}

function WaAutomationPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await listAutomations();
      const all = res.automations || [];
      setItems(all.filter((a: any) => {
        const ch = String(a.channel || a.triggerChannel || a.config?.channel || '').toLowerCase();
        const name = String(a.name || a.title || '').toLowerCase();
        return !ch || ch === 'whatsapp' || ch === 'any' || name.includes('whatsapp') || name.includes('follow');
      }));
    } catch (err) {
      setError(errMessage(err, 'Failed to load automations'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="wa-card glow-purple">
      <h3 className="wa-section-title">Automation</h3>
      <p className="wa-muted">Auto replies, follow-ups, stop/restart, and human/AI takeover for WhatsApp.</p>
      <div className="wa-actions">
        <Link className="lf-btn lf-btn-primary" to="/app/automations">Open Automations</Link>
        <Link className="lf-btn" to="/app/inbox?channel=whatsapp">Inbox WhatsApp threads</Link>
        <button className="lf-btn" type="button" onClick={onOpenChat}>AI / Human takeover in chat</button>
        <button
          className="lf-btn"
          type="button"
          onClick={async () => {
            setMsg('');
            try {
              const res = await processDueFollowUps();
              setMsg(`Follow-ups processed: ${res.processed || 0}, sent: ${res.sent || 0}`);
            } catch (err) {
              setError(errMessage(err, 'Follow-up processing failed'));
            }
          }}
        >
          Run due follow-ups
        </button>
      </div>
      {msg && <div className="lf-alert" style={{ marginTop: 12 }}>{msg}</div>}
      {error && <div className="lf-alert lf-alert-error" style={{ marginTop: 12 }}>{error}</div>}
      <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        {items.length === 0 && <div className="wa-muted">No WhatsApp-related automations found yet. Create them in Automations.</div>}
        {items.map((a) => (
          <div key={a.id} className="wa-list-item" style={{ cursor: 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <strong>{a.name || a.title || a.id}</strong>
                <div className="wa-muted">{a.trigger || a.triggerType || 'automation'} · {a.enabled ? 'enabled' : 'stopped'}</div>
              </div>
              <div className="wa-actions" style={{ marginTop: 0 }}>
                {a.enabled ? (
                  <button className="lf-btn" type="button" disabled={busyId === a.id} onClick={async () => {
                    setBusyId(a.id);
                    try { await disableAutomation(a.id); await load(); } catch (err) { setError(errMessage(err, 'Stop failed')); }
                    finally { setBusyId(''); }
                  }}>Stop automation</button>
                ) : (
                  <button className="lf-btn lf-btn-primary" type="button" disabled={busyId === a.id} onClick={async () => {
                    setBusyId(a.id);
                    try { await enableAutomation(a.id); await load(); } catch (err) { setError(errMessage(err, 'Restart failed')); }
                    finally { setBusyId(''); }
                  }}>Restart automation</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WaConversationsPanel() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [reply, setReply] = useState('');
  const [attachUrl, setAttachUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await getConversations();
    const wa = (res.conversations || []).filter((c) => c.channel === 'whatsapp');
    setConversations(wa);
  }, []);

  useEffect(() => { void load().catch((e) => setError(errMessage(e, 'Failed to load conversations'))); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { void load(); }, 10000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    (async () => {
      try {
        const res = await getMessages(selectedId);
        if (active) setMessages(res.messages || []);
        await markConversationRead(selectedId).catch(() => null);
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load messages'));
      }
    })();
    return () => { active = false; };
  }, [selectedId]);

  const stageOptions = useMemo(() => {
    const set = new Set<string>();
    conversations.forEach((c) => set.add(c.pipelineStatus || 'new'));
    return ['all', ...Array.from(set)];
  }, [conversations]);

  const filtered = useMemo(() => {
    let list = conversations;
    if (filter === 'unread') list = list.filter((c) => (c.unreadCount || 0) > 0);
    if (filter === 'starred') list = list.filter((c) => c.pinned);
    if (stageFilter !== 'all') list = list.filter((c) => (c.pipelineStatus || 'new') === stageFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) =>
        (c.lead?.name || c.contact?.name || '').toLowerCase().includes(q)
        || (c.subject || '').toLowerCase().includes(q)
        || (c.leadId || '').toLowerCase().includes(q));
    }
    return list;
  }, [conversations, filter, search, stageFilter]);

  const selected = conversations.find((c) => c.id === selectedId) || null;
  const selectedName = selected?.lead?.name || selected?.contact?.name || selected?.leadId || '';
  const selectedPhone = selected?.lead?.phone || selected?.contact?.phone || '';

  const send = async () => {
    if (!selectedId || !reply.trim()) return;
    setBusy(true); setError('');
    try {
      await sendConversationReply(selectedId, {
        body: reply.trim(),
        imageUrl: attachUrl.trim() || undefined,
      });
      setReply('');
      setAttachUrl('');
      const res = await getMessages(selectedId);
      setMessages(res.messages || []);
      await load();
    } catch (err) {
      setError(errMessage(err, 'Send failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wa-card glow-green">
      <h3 className="wa-section-title">WhatsApp Conversations</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input className="lf-input" style={{ flex: 1, minWidth: 180 }} placeholder="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} />
        {(['all', 'unread', 'starred'] as const).map((f) => (
          <button key={f} type="button" className={`lf-btn ${filter === f ? 'lf-btn-primary' : ''}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <select className="lf-input" style={{ width: 160 }} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} aria-label="Campaign / stage filter">
          {stageOptions.map((s) => <option key={s} value={s}>{s === 'all' ? 'All stages' : `Stage: ${s}`}</option>)}
        </select>
        <Link className="lf-btn" to="/app/inbox?channel=whatsapp">Open Inbox</Link>
      </div>
      {error && <div className="lf-alert lf-alert-error" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="wa-split">
        <div className="wa-list">
          {filtered.length === 0 && <div className="wa-muted">No WhatsApp conversations yet.</div>}
          {filtered.map((c) => (
            <button key={c.id} type="button" className={`wa-list-item ${selectedId === c.id ? 'is-active' : ''}`} onClick={() => setSelectedId(c.id)}>
              <div style={{ fontWeight: 700 }}>{c.pinned ? '★ ' : ''}{c.lead?.name || c.contact?.name || c.leadId}</div>
              <div className="wa-muted">{c.lastMessage?.body?.slice(0, 80) || c.subject || 'No messages'}</div>
              <div className="wa-muted">{c.pipelineStatus || 'new'}</div>
              {(c.unreadCount || 0) > 0 && <span className="lf-pill lf-pill-on">{c.unreadCount} unread</span>}
            </button>
          ))}
        </div>
        <div className="wa-chat">
          {!selected && <div className="wa-muted">Select a conversation</div>}
          {selected && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <strong>{selectedName}</strong>
                  <div className="wa-muted">Lead linked · stage {selected.pipelineStatus || 'new'}{selectedPhone ? ` · ${selectedPhone}` : ''}</div>
                </div>
                <div className="wa-actions" style={{ marginTop: 0 }}>
                  {!selected.leadId?.startsWith('contact:') && (
                    <Link className="lf-btn" to={`/app/leads?focus=${encodeURIComponent(selected.leadId)}`}>Open lead profile</Link>
                  )}
                  <Link className="lf-btn" to="/app/inbox" title="Create and manage quotes in Inbox">Quotes in Inbox</Link>
                  <button className="lf-btn" type="button" onClick={async () => {
                    if (selected.pinned) await unpinConversation(selected.id);
                    else await pinConversation(selected.id);
                    await load();
                  }}>{selected.pinned ? 'Unstar' : 'Star'}</button>
                  <button className="lf-btn" type="button" onClick={async () => { await archiveConversation(selected.id); setSelectedId(null); await load(); }}>Mark resolved</button>
                  <button className="lf-btn" type="button" onClick={async () => { await updateCampaignStatus(selected.leadId, 'interested'); await load(); }}>Interested</button>
                  <button className="lf-btn" type="button" onClick={async () => { await updateCampaignStatus(selected.leadId, 'meeting'); await load(); }}>Meeting</button>
                  <button className="lf-btn" type="button" onClick={async () => { await updateCampaignStatus(selected.leadId, 'deal'); await load(); }}>Deal</button>
                </div>
              </div>
              <div className="wa-chat-messages">
                {messages.map((m) => {
                  const quoteMeta = (m.metadata as any)?.quoteCard || m.messageType === 'quote'
                    ? (m.metadata as any)
                    : null;
                  return (
                    <div key={m.id} className={`wa-bubble ${m.direction === 'outbound' ? 'out' : 'in'}`}>
                      {quoteMeta ? (
                        <div className="qi-thread-quote-card">
                          <div className="qi-thread-quote-badge">
                            {(quoteMeta.docType === 'invoice' ? 'Invoice' : 'Quotation')} · {quoteMeta.status || 'sent'}
                          </div>
                          <div className="qi-thread-quote-number">{quoteMeta.number || 'Document'}</div>
                          <div className="qi-thread-quote-total">
                            {quoteMeta.currency || 'MYR'}{' '}
                            {Number(quoteMeta.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div className="qi-thread-quote-actions">
                            {quoteMeta.shareUrl && (
                              <a className="lf-btn" href={quoteMeta.shareUrl} target="_blank" rel="noreferrer" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>Open link</a>
                            )}
                            {quoteMeta.quoteId && (
                              <a className="lf-btn" href={`/api/quotes/${quoteMeta.quoteId}/pdf`} target="_blank" rel="noreferrer" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>PDF</a>
                            )}
                          </div>
                        </div>
                      ) : (
                        <MessageContent content={m.body || ''} />
                      )}
                      <div className="wa-muted" style={{ marginTop: 4 }}>{m.status || m.direction} · {m.createdAt ? new Date(m.createdAt).toLocaleString() : ''}</div>
                    </div>
                  );
                })}
              </div>
              <div className="wa-actions">
                <button className="lf-btn" type="button" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await generateReply(selected.id);
                    setReply(res?.suggestion?.body || '');
                  } catch (err) { setError(errMessage(err, 'AI reply failed')); }
                  finally { setBusy(false); }
                }}>AI suggested reply</button>
                <button className="lf-btn" type="button" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    await autoReply(selected.id);
                    const res = await getMessages(selected.id);
                    setMessages(res.messages || []);
                    await load();
                  } catch (err) { setError(errMessage(err, 'Auto-reply failed')); }
                  finally { setBusy(false); }
                }}>AI takeover</button>
              </div>
              <input
                className="lf-input"
                style={{ marginBottom: 8 }}
                placeholder="Optional public media URL (image / PDF / video)"
                value={attachUrl}
                onChange={(e) => setAttachUrl(e.target.value)}
              />
              <div className="wa-composer-row">
                <textarea className="lf-textarea" style={{ flex: 1, minHeight: 64 }} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Human takeover — type a reply" />
                <button className="lf-btn lf-btn-primary" type="button" disabled={busy || !reply.trim()} onClick={() => void send()}>Send</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WaLogsPanel() {
  const [logs, setLogs] = useState<any[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    getWhatsAppLogs(100)
      .then((res) => setLogs(res.logs || []))
      .catch((err) => setError(errMessage(err, 'Failed to load logs')));
  }, []);
  return (
    <div className="wa-card glow-orange">
      <h3 className="wa-section-title">Message log (database)</h3>
      {error && <div className="lf-alert lf-alert-error">{error}</div>}
      <div className="wa-log-row" style={{ fontWeight: 700, color: '#94a3b8' }}>
        <span>Time</span><span>Direction</span><span>Status</span><span>Body</span>
      </div>
      {logs.length === 0 && <div className="wa-muted">No WhatsApp message rows yet.</div>}
      {logs.map((l) => (
        <div key={l.id} className="wa-log-row">
          <span>{l.createdAt ? new Date(l.createdAt).toLocaleString() : '—'}</span>
          <span>{l.direction}</span>
          <span>{l.status || '—'}</span>
          <span>{l.body}</span>
        </div>
      ))}
    </div>
  );
}

function KpiCard({ label, value, icon, iconClass, cardClass, suffix = '', gradient }: {
  label: string; value: number; icon: string; iconClass: string; cardClass: string; suffix?: string; gradient?: string;
}) {
  return (
    <div className={`lf-card-premium ${cardClass}`} style={gradient ? { background: gradient } : undefined}>
      <div className="lf-card-accent" />
      <div className={`lf-kpi-icon-wrap ${iconClass}`}>{icon}</div>
      <div className="lf-kpi-value-premium">{value.toLocaleString()}{suffix}</div>
      <div className="lf-kpi-label-premium">{label}</div>
    </div>
  );
}

function SalesPipeline({ byStatus, onStageClick, activeFilter, entityLabel = 'Lead' }: {
  byStatus: { new?: number; sent?: number; replied?: number; interested?: number; meeting?: number; deal?: number; lost?: number } | null;
  onStageClick: (stage: string) => void;
  activeFilter: string | null;
  entityLabel?: string;
}) {
  const s = byStatus || { new: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0 };

  const stages = [
    { label: `New ${entityLabel}`, count: Number(s.new || 0), color: '#64748b', bg: 'rgba(100, 116, 139, 0.15)', key: 'new' },
    { label: 'Message Sent', count: Number(s.sent || 0), color: '#22d3ee', bg: 'rgba(6, 182, 212, 0.15)', key: 'sent' },
    { label: 'Replied', count: Number(s.replied || 0), color: '#a78bfa', bg: 'rgba(139, 92, 246, 0.15)', key: 'replied' },
    { label: 'Interested', count: Number(s.interested || 0), color: '#fbbf24', bg: 'rgba(245, 158, 11, 0.15)', key: 'interested' },
    { label: 'Meeting', count: Number(s.meeting || 0), color: '#f472b6', bg: 'rgba(244, 114, 182, 0.15)', key: 'meeting' },
    { label: 'Deal Won', count: Number(s.deal || 0), color: '#34d399', bg: 'rgba(16, 185, 129, 0.15)', key: 'deal' },
  ];

  return (
    <div className="lf-card-premium" style={{ marginBottom: 20, padding: 22 }}>
      <div className="lf-card-accent" />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Sales Pipeline</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {stages.map((s, i) => {
          const isActive = activeFilter === s.key;
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => onStageClick(s.key)}
                style={{
                  width: '100%', borderRadius: 12, padding: '12px 6px',
                  background: isActive ? `${s.color}35` : s.bg,
                  border: isActive ? `2px solid ${s.color}` : `1px solid ${s.color}30`,
                  textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                }}
                title={`Filter by ${s.label}`}
              >
                <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.count}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: s.color, marginTop: 4 }}>{s.label}</div>
              </button>
              {i < stages.length - 1 && (
                <div style={{ fontSize: 14, color: 'var(--lf-muted)', marginTop: -2 }}>→</div>
              )}
            </div>
          );
        })}
      </div>
      {activeFilter && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button className="lf-pill" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => onStageClick('')}>
            Clear filter: {stages.find(s => s.key === activeFilter)?.label}
          </button>
        </div>
      )}
    </div>
  );
}

function AiMessageGenerator() {
  const [businessType, setBusinessType] = useState('gym');
  const [goal, setGoal] = useState('booking');
  const [language, setLanguage] = useState('en');
  const [tone, setTone] = useState('professional');
  const [length, setLength] = useState('medium');
  const [writingStyle, setWritingStyle] = useState('native');
  const [generated, setGenerated] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await generateAIMessageApi({ businessType, goal, language, tone, length, writingStyle });
      setGenerated(res.message);
      setCopied(false);
    } catch (err) {
      setError(errMessage(err, 'Failed to generate message'));
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="lf-card-premium" style={{ padding: 22 }}>
      <div className="lf-card-accent" />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>AI Message Generator</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Business Type</label>
            <input
              className="scraper-input"
              style={{ marginTop: 6, width: '100%' }}
              list="business-types"
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              placeholder="Type or select a business type..."
            />
            <datalist id="business-types">
              <option value="gym" />
              <option value="dentist" />
              <option value="lawyer" />
              <option value="restaurant" />
              <option value="salon" />
              <option value="realtor" />
              <option value="plumber" />
              <option value="hvac" />
              <option value="roofer" />
              <option value="electrician" />
              <option value="clinic" />
              <option value="accountant" />
              <option value="solar company" />
              <option value="car wash" />
              <option value="pest control" />
              <option value="marketing agency" />
              <option value="roof repair" />
              <option value="beauty salon" />
              <option value="spa" />
              <option value="pet grooming" />
              <option value="cleaning service" />
              <option value="landscaping" />
              <option value="moving company" />
              <option value="photography" />
              <option value="tutoring" />
              <option value="home renovation" />
              <option value="interior design" />
              <option value="catering" />
              <option value="coffee shop" />
              <option value="barber shop" />
              <option value="auto repair" />
              <option value="bike shop" />
              <option value="yoga studio" />
              <option value="dance studio" />
              <option value="music school" />
              <option value="daycare" />
              <option value="pharmacy" />
              <option value="veterinary clinic" />
              <option value="travel agency" />
              <option value="event planning" />
              <option value="printing service" />
              <option value="IT support" />
              <option value="web design" />
              <option value="SEO agency" />
              <option value="consulting firm" />
            </datalist>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Goal</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={goal} onChange={(e) => setGoal(e.target.value)}>
              <option value="booking">Book Appointment</option>
              <option value="demo">Request Demo</option>
              <option value="followup">Follow Up</option>
              <option value="offer">Special Offer</option>
              <option value="meeting">Schedule Meeting</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Language</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">🇺🇸 English (US)</option>
              <option value="en-GB">🇬🇧 English (UK)</option>
              <option value="ar">🇸🇦 Arabic</option>
              <option value="ur">🇵🇰 Urdu</option>
              <option value="hi">🇮🇳 Hindi</option>
              <option value="bn">🇧🇩 Bengali</option>
              <option value="pa">🇮🇳 Punjabi</option>
              <option value="ta">🇮🇳 Tamil</option>
              <option value="te">🇮🇳 Telugu</option>
              <option value="ml">🇮🇳 Malayalam</option>
              <option value="mr">🇮🇳 Marathi</option>
              <option value="gu">🇮🇳 Gujarati</option>
              <option value="kn">🇮🇳 Kannada</option>
              <option value="zh">🇨🇳 Chinese (Simplified)</option>
              <option value="zh-TW">🇹🇼 Chinese (Traditional)</option>
              <option value="ja">🇯🇵 Japanese</option>
              <option value="ko">🇰🇷 Korean</option>
              <option value="th">🇹🇭 Thai</option>
              <option value="vi">🇻🇳 Vietnamese</option>
              <option value="id">🇮🇩 Indonesian</option>
              <option value="ms">🇲🇾 Malay</option>
              <option value="tr">🇹🇷 Turkish</option>
              <option value="fa">🇮🇷 Persian</option>
              <option value="ru">🇷🇺 Russian</option>
              <option value="uk">🇺🇦 Ukrainian</option>
              <option value="de">🇩🇪 German</option>
              <option value="fr">🇫🇷 French</option>
              <option value="es">🇪🇸 Spanish</option>
              <option value="pt">🇵🇹 Portuguese</option>
              <option value="it">🇮🇹 Italian</option>
              <option value="nl">🇳🇱 Dutch</option>
              <option value="pl">🇵🇱 Polish</option>
              <option value="ro">🇷🇴 Romanian</option>
              <option value="el">🇬🇷 Greek</option>
              <option value="sv">🇸🇪 Swedish</option>
              <option value="no">🇳🇴 Norwegian</option>
              <option value="da">🇩🇰 Danish</option>
              <option value="fi">🇫🇮 Finnish</option>
              <option value="cs">🇨🇿 Czech</option>
              <option value="hu">🇭🇺 Hungarian</option>
              <option value="he">🇮🇱 Hebrew</option>
              <option value="bg">🇧🇬 Bulgarian</option>
              <option value="hr">🇭🇷 Croatian</option>
              <option value="sr">🇷🇸 Serbian</option>
              <option value="sk">🇸🇰 Slovak</option>
              <option value="sl">🇸🇮 Slovenian</option>
              <option value="lt">🇱🇹 Lithuanian</option>
              <option value="lv">🇱🇻 Latvian</option>
              <option value="et">🇪🇪 Estonian</option>
              <option value="tl">🇵🇭 Tagalog</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tone</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={tone} onChange={(e) => setTone(e.target.value)}>
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="casual">Casual</option>
              <option value="luxury">Luxury</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Length</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={length} onChange={(e) => setLength(e.target.value)}>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Writing Style</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={writingStyle} onChange={(e) => setWritingStyle(e.target.value)}>
              <option value="native">Native (default)</option>
              <option value="translated">Translated</option>
            </select>
          </div>
        </div>
      </div>

      <button className="scraper-search-btn" style={{ width: '100%', marginBottom: 12 }} onClick={generate} disabled={loading}>
        <span style={{ fontSize: 15 }}>{loading ? '⏳' : generated ? '🔄' : '✨'}</span> {loading ? 'Generating…' : generated ? 'Regenerate' : 'Generate Message'}
      </button>
      {error && (
        <div style={{ color: '#fb7185', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      {generated && (
        <div style={{ position: 'relative' }}>
          <div style={{
            background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--lf-card-border)',
            borderRadius: 12, padding: 14, fontSize: 14, lineHeight: 1.6, color: 'var(--lf-text)',
            minHeight: 60,
          }}>
            <MessageContent content={generated} format="text" />
          </div>
          <button onClick={copy} style={{
            position: 'absolute', top: 8, right: 8, fontSize: 12, padding: '4px 10px',
            borderRadius: 6, border: '1px solid var(--lf-card-border)', background: 'rgba(15,23,42,0.8)',
            color: copied ? '#34d399' : 'var(--lf-text-secondary)', cursor: 'pointer'
          }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

function CampaignAnalytics({ total, withPhone, sent, replies, followUpsSent, meetings, deals, entityLabel = 'Leads' }: { total: number; withPhone: number; sent: number; replies: number; followUpsSent: number; meetings: number; deals: number; entityLabel?: string }) {
  const replyRate = sent > 0 ? Math.round((replies / sent) * 100) : 0;
  const closeRate = replies > 0 ? Math.round((deals / Math.max(replies, 1)) * 100) : 0;

  const rows = [
    { label: `Total ${entityLabel}`, value: total, color: '#94a3b8' },
    { label: 'WhatsApp Available', value: withPhone, color: '#22d3ee' },
    { label: 'Messages Sent', value: sent, color: '#a78bfa' },
    { label: 'Replies Received', value: replies, color: '#fbbf24' },
    { label: 'Follow Ups Sent', value: followUpsSent, color: '#f472b6' },
    { label: 'Meetings Booked', value: meetings, color: '#818cf8' },
    { label: 'Deals Closed', value: deals, color: '#34d399' },
  ];

  return (
    <div className="lf-card-premium" style={{ padding: 22 }}>
      <div className="lf-card-accent" />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Campaign Analytics</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'var(--lf-text-secondary)' }}>{r.label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: r.color }}>{r.value.toLocaleString()}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--lf-card-border)', display: 'flex', gap: 16 }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#fbbf24' }}>{replyRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginTop: 2 }}>Reply Rate</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#34d399' }}>{closeRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginTop: 2 }}>Close Rate</div>
        </div>
      </div>
    </div>
  );
}

function ComposeCard({ configured, leads, scores, campaigns, onCampaignChange, pipelineFilter, onClearFilter }: {
  configured: boolean; leads: Lead[]; scores: ScoredLead[]; campaigns: CampaignRecord[]; onCampaignChange: () => Promise<void>; pipelineFilter: string | null; onClearFilter: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [message, setMessage] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [previewSettings, setPreviewSettings] = useState<{ whatsappPreview: boolean; emailPreview: boolean; smsPreview: boolean; previewPhone: string; previewEmail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<WhatsAppBulkResponse | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [templates] = useState<WhatsAppTemplate[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  // Image upload
  const [imageAttachment, setImageAttachment] = useState<{ dataUrl: string; url: string; uploading: boolean } | null>(null);
  const [mediaType, setMediaType] = useState<'none' | 'image' | 'document' | 'video'>('none');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaFilename, setMediaFilename] = useState('document.pdf');
  const EMOJIS = ['😊', '👍', '🔥', '✅', '📅', '💼', '🚀', '🙏'];

  // Bulk campaign mode — read from sessionStorage once during initial render (survives StrictMode)
  const [bulkMode] = useState(() => hasTransferredLeads('whatsapp'));
  const contactsOnlyMode = isContactsSource('whatsapp');

  // Filters
  const [scoreFilter, setScoreFilter] = useState<'all' | 'hot' | 'warm' | 'cold'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    buildInitialSelection(getTransferredLeadsForChannel('whatsapp'))
  );

  // Auto-fill message from URL params — mount only
  useEffect(() => {
    const msg = searchParams.get('msg');
    if (msg) setMessage(decodeURIComponent(msg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle leadId from URL when leads load (skip if bulk mode already active)
  useEffect(() => {
    const leadId = searchParams.get('lead');
    if (leadId && leads.length > 0 && !bulkMode) {
      const target = leads.find((l) => l.id === leadId || l.phone === leadId);
      if (target) {
        setSelected({ [target.id]: true });
        setShowPreview(true);
      }
      const next = new URLSearchParams(searchParams);
      next.delete('lead'); next.delete('msg');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads.length, bulkMode]);

  // Campaign Draft Persistence
  const DRAFT_KEY = 'lf_draft_whatsapp';

  // Load draft on mount. In bulk mode, only restore message/image/preview,
  // NOT selected leads (those come from sessionStorage bulkCampaign).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.message !== undefined) setMessage(draft.message);
        if (draft.imageAttachment) setImageAttachment(draft.imageAttachment);
        if (draft.previewMode !== undefined) setPreviewMode(draft.previewMode);
        if (!bulkMode && draft.selected && typeof draft.selected === 'object') {
          setSelected(draft.selected);
        }
        setDraftLoaded(true);
      }
    } catch { /* ignore corrupt draft */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft whenever composer state changes
  // In bulk mode, still save message/image/preview, but keep selected from sessionStorage.
  useEffect(() => {
    const draft = {
      message,
      imageAttachment: imageAttachment ? { url: imageAttachment.url, dataUrl: imageAttachment.dataUrl } : null,
      previewMode,
      selected: bulkMode ? undefined : selected,
      timestamp: Date.now(),
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch { /* localStorage may be full */ }
  }, [message, imageAttachment, previewMode, selected, bulkMode, DRAFT_KEY]);

  const clearDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    setDraftLoaded(false);
  };

  // Image compression helper
  const compressImage = async (file: File): Promise<string> => {
    const img = new Image();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; });

    const maxDim = 1200;
    const canvas = document.createElement('canvas');
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0, w, h);

    let quality = 0.85;
    let compressed = canvas.toDataURL('image/jpeg', quality);
    while (compressed.length > 3 * 1024 * 1024 && quality > 0.3) {
      quality -= 0.1;
      compressed = canvas.toDataURL('image/jpeg', quality);
    }
    return compressed;
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setError('Please upload JPG, JPEG, PNG, or WEBP only.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Max 10 MB.');
      return;
    }
    setImageAttachment((prev) => prev ? { ...prev, uploading: true } : { dataUrl: '', url: '', uploading: true });
    try {
      const compressed = file.size > 1 * 1024 * 1024 ? await compressImage(file) : await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { url } = await uploadImage(compressed, file.name);
      setImageAttachment({ dataUrl: compressed, url, uploading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Image upload failed';
      console.error('[Image Upload Error]', msg, err);
      setError(msg);
      setImageAttachment(null);
    }
  };

  const removeImage = () => setImageAttachment(null);

  const safeScores = scores ?? [];
  const safeCampaigns = campaigns ?? [];

  const scoreMap = useMemo(() => {
    const m = new Map<string, string>();
    safeScores.forEach((s) => { if (s?.priority) m.set(s.leadId, s.priority); });
    return m;
  }, [safeScores]);

  const campaignMap = useMemo(() => {
    const m = new Map<string, CampaignRecord>();
    safeCampaigns.forEach((c) => { if (c?.leadId) m.set(c.leadId, c); });
    return m;
  }, [safeCampaigns]);

  const filteredLeads = useMemo(() => {
    let list = (leads ?? []).filter(hasPhone);
    if (bulkMode) {
      list = list.filter((l) => selected[l.id]);
    } else {
      if (pipelineFilter) {
        list = list.filter((l) => {
          const c = campaignMap.get(l.id);
          if (pipelineFilter === 'new') return !c || c.status === 'new';
          return c?.status === pipelineFilter;
        });
      }
      if (scoreFilter !== 'all') {
        list = list.filter((l) => scoreMap.get(l.id) === scoreFilter);
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        list = list.filter((l) =>
          (l.name || '').toLowerCase().includes(q) ||
          (l.city || '').toLowerCase().includes(q) ||
          (l.niche || '').toLowerCase().includes(q)
        );
      }
    }
    return list;
  }, [leads, scoreFilter, search, scoreMap, pipelineFilter, campaignMap, bulkMode, selected]);

  const selectedLeads = useMemo(() => filteredLeads.filter((l) => selected[l.id]), [filteredLeads, selected]);
  const allSelected = filteredLeads.length > 0 && selectedLeads.length === filteredLeads.length;

  // Auto-replace placeholders when leads are selected
  useEffect(() => {
    if (selectedLeads.length === 0) return;
    const first = selectedLeads[0];
    if (!first) return;
    setMessage((prev) => {
      if (!prev) return prev;
      const hasPlaceholders = /\{name\}/.test(prev) || /\{city\}/.test(prev) || /\{niche\}/.test(prev);
      if (!hasPlaceholders) return prev;
      return prev
        .replace(/\{name\}/g, first.name || 'there')
        .replace(/\{city\}/g, first.city || 'your city')
        .replace(/\{niche\}/g, first.niche || 'business');
    });
  }, [selected]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await getPreviewSettings();
        if (active && res.settings) setPreviewSettings(res.settings);
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, []);

  const toggleAll = () => {
    if (allSelected) {
      const next = { ...selected };
      filteredLeads.forEach((l) => { delete next[l.id]; });
      setSelected(next);
    } else {
      const next = { ...selected };
      filteredLeads.forEach((l) => { next[l.id] = true; });
      setSelected(next);
    }
  };

  const resolvedMediaUrl = mediaType === 'image'
    ? (imageAttachment?.url || mediaUrl.trim())
    : (mediaType === 'document' || mediaType === 'video' ? mediaUrl.trim() : '');

  const sendCampaign = async () => {
    setBusy(true); setError(null); setBulkResult(null);
    try {
      await controlWhatsAppCampaign('start', { total: selectedLeads.length }).catch(() => null);
      // Media campaigns (non-image or image+caption via Meta media API)
      if (mediaType !== 'none' && resolvedMediaUrl && mediaType !== 'image') {
        let sent = 0;
        let failed = 0;
        const results: any[] = [];
        for (const lead of selectedLeads) {
          try {
            const caption = message
              .replace(/\{name\}/g, lead.name || 'there')
              .replace(/\{city\}/g, lead.city || '')
              .replace(/\{niche\}/g, lead.niche || 'business');
            await sendWhatsAppMedia({
              phone: String(lead.phone),
              leadId: lead.id,
              mediaType,
              mediaUrl: resolvedMediaUrl,
              caption,
              filename: mediaFilename || 'document.pdf',
              testMode: false,
            });
            sent += 1;
            results.push({ status: 'sent', message: 'Media sent' });
            try { await recordSent(lead.id, false); } catch { /* ignore */ }
          } catch (err) {
            failed += 1;
            results.push({ status: 'failed', message: errMessage(err, 'Failed') });
          }
        }
        setBulkResult({ sent, failed, skipped: 0, total: selectedLeads.length, testMode: false, results } as unknown as WhatsAppBulkResponse);
        await controlWhatsAppCampaign('complete').catch(() => null);
      } else {
        // When mediaType is 'none' (text only), NEVER send imageUrl regardless of draft state
        const resolvedImageUrl = mediaType === 'none' ? undefined
          : imageAttachment?.url || (mediaType === 'image' ? mediaUrl.trim() : undefined) || undefined;
        const res = await sendCampaignWithPreview({
          channel: 'whatsapp',
          leads: selectedLeads.map((l: any) => ({ id: l.id, contactId: l.contactId, source: l.source, phone: l.phone, name: l.name || 'Lead', city: l.city, niche: l.niche })),
          message: message.trim(),
          previewMode,
          imageUrl: resolvedImageUrl,
        });
        setBulkResult({
          sent: res.sent,
          failed: res.failed,
          skipped: res.total - res.sent - res.failed,
          total: res.total,
          testMode: false,
          results: res.results.map((r: any) => ({
            status: r.status,
            message: r.status === 'sent' ? `Sent. ID: ${r.messageId || '—'}` : r.error || 'Failed',
          })),
          previewSent: res.previewSent,
          previewResult: res.previewResult,
        } as unknown as WhatsAppBulkResponse);
        for (const lead of selectedLeads) {
          try { await recordSent(lead.id, false); } catch { /* ignore */ }
        }
      }
      clearDraft();
      clearBulkCampaign();
      setSelected({});
      await onCampaignChange();
    } catch (err) {
      setError(errMessage(err, 'Campaign send failed'));
    } finally {
      setBusy(false);
    }
  };

  const sendTestMessage = async () => {
    if (selectedLeads.length === 0) {
      setError('Select at least one contact for the test message');
      return;
    }
    const lead = selectedLeads[0];
    setBusy(true); setError(null);
    try {
      const caption = message
        .replace(/\{name\}/g, lead.name || 'there')
        .replace(/\{city\}/g, lead.city || '')
        .replace(/\{niche\}/g, lead.niche || 'business');
      if (mediaType !== 'none' && resolvedMediaUrl) {
        await sendWhatsAppMedia({
          phone: String(lead.phone),
          leadId: lead.id,
          mediaType,
          mediaUrl: resolvedMediaUrl,
          caption: caption || 'Test message',
          filename: mediaFilename,
          testMode: true,
        });
      } else {
        await sendWhatsAppBulk({
          leads: [{ id: lead.id, phone: lead.phone, name: lead.name || 'Lead', city: lead.city, niche: lead.niche }],
          message: caption || 'Test message',
          testMode: true,
        });
      }
      setBulkResult({ sent: 1, failed: 0, skipped: 0, total: 1, testMode: true, results: [{ status: 'sent', message: 'Test message accepted' }] } as unknown as WhatsAppBulkResponse);
    } catch (err) {
      setError(errMessage(err, 'Test message failed'));
    } finally {
      setBusy(false);
    }
  };

  const campaignDisabled = busy || message.trim() === '' || selectedLeads.length === 0 || selectedLeads.length > MAX_BATCH || !configured;

  const renderPreview = (lead: Lead) => {
    return message
      .replace(/\{name\}/g, lead.name || 'there')
      .replace(/\{city\}/g, lead.city || 'your city')
      .replace(/\{niche\}/g, lead.niche || 'business');
  };

  const scoreBadge = (leadId: string) => {
    const p = scoreMap.get(leadId);
    if (!p) return <span className="lf-pill" style={{ fontSize: 10 }}>—</span>;
    const colors: Record<string, string> = { hot: '#fb7185', warm: '#fbbf24', cold: '#94a3b8' };
    return <span className="lf-pill" style={{ background: `${colors[p]}20`, color: colors[p], fontSize: 10, fontWeight: 700 }}>{p.toUpperCase()}</span>;
  };

  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, string>>({});

  const statusBadge = (leadId: string) => {
    const opt = optimisticStatuses[leadId];
    const c = campaignMap.get(leadId);
    const st = opt || c?.status || 'new';
    if (st === 'new') return <span className="lf-pill" style={{ fontSize: 10 }}>NEW</span>;
    const colors: Record<string, string> = {
      sent: '#22d3ee', replied: '#a78bfa', interested: '#fbbf24', meeting: '#f472b6', deal: '#34d399', lost: '#64748b'
    };
    return <span className="lf-pill" style={{ background: `${colors[st]}20`, color: colors[st], fontSize: 10, fontWeight: 700 }}>{st.toUpperCase()}</span>;
  };

  const markStatus = async (leadId: string, status: string) => {
    setOptimisticStatuses((prev) => ({ ...prev, [leadId]: status }));
    try {
      await updateCampaignStatus(leadId, status);
      await onCampaignChange();
      setOptimisticStatuses((prev) => { const n = { ...prev }; delete n[leadId]; return n; });
    } catch (e) {
      setError(errMessage(e, 'Failed to update status'));
      setOptimisticStatuses((prev) => { const n = { ...prev }; delete n[leadId]; return n; });
      await onCampaignChange();
    }
  };

  return (
    <div className="lf-card-premium" style={{ padding: 22 }}>
      <div className="lf-card-accent" />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Campaign Composer</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {pipelineFilter && (
            <button className="lf-pill" style={{ fontSize: 11, cursor: 'pointer' }} onClick={onClearFilter}>
              Clear: {pipelineFilter}
            </button>
          )}
          <label className="lf-switch" title="Preview Mode sends you a copy so you can verify before going live">
            <input type="checkbox" checked={previewMode} onChange={(e) => setPreviewMode(e.target.checked)} />
            Preview Mode {previewMode ? '(on)' : '(off)'}
          </label>
        </div>
      </div>

      {previewMode && previewSettings && (
        <div className="lf-alert lf-alert-info" style={{ marginBottom: 12 }}>
          Preview Mode ON — you will receive a copy on {previewSettings.whatsappPreview ? `WhatsApp (${previewSettings.previewPhone || 'your number'})` : ''}
          {previewSettings.whatsappPreview && previewSettings.emailPreview ? ' and ' : ''}
          {previewSettings.emailPreview ? `Email (${previewSettings.previewEmail || 'your email'})` : ''}.
          <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>Enable previews per channel in Settings → Preview & Testing.</div>
        </div>
      )}
      {!configured && (
        <div className="lf-note" style={{ marginBottom: 12 }}>
          Connect WhatsApp credentials to enable live sending.
        </div>
      )}

      {/* Message composer */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Message / caption — supports {'{name}'}, {'{city}'}, {'{niche}'}
        </label>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          {EMOJIS.map((e) => (
            <button key={e} type="button" className="lf-btn" style={{ padding: '4px 8px' }} onClick={() => setMessage((m) => `${m}${e}`)}>{e}</button>
          ))}
          {['{name}', '{city}', '{niche}'].map((v) => (
            <button key={v} type="button" className="lf-btn" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => setMessage((m) => `${m}${v}`)}>{v}</button>
          ))}
        </div>
        <textarea
          className="lf-textarea"
          style={{ minHeight: 100, fontSize: 14 }}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Paste your AI-generated message or type a custom one…"
        />
      </div>

      {/* Attachments */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Attachments
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          {(['none', 'image', 'document', 'video'] as const).map((t) => (
            <button key={t} type="button" className={`lf-btn ${mediaType === t ? 'lf-btn-primary' : ''}`} onClick={() => setMediaType(t)}>
              {t === 'none' ? 'Text only' : t === 'image' ? 'Image' : t === 'document' ? 'PDF / Document' : 'Video'}
            </button>
          ))}
        </div>
        {mediaType === 'image' && (
          <div style={{ marginTop: 10 }}>
            {!imageAttachment ? (
              <label className="lf-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
                Upload image
              </label>
            ) : (
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <img src={imageAttachment.dataUrl} alt="Campaign" style={{ maxHeight: 120, borderRadius: 8, border: '1px solid var(--lf-card-border)' }} />
                <button className="lf-btn lf-btn-danger" style={{ position: 'absolute', top: 4, right: 4, padding: '2px 8px', fontSize: 11 }} onClick={removeImage}>✕</button>
              </div>
            )}
            {imageAttachment?.uploading && <span style={{ fontSize: 12, marginLeft: 8, color: 'var(--lf-text-secondary)' }}>Uploading…</span>}
            <input className="lf-input" style={{ marginTop: 8 }} placeholder="Or paste public image URL" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
          </div>
        )}
        {(mediaType === 'document' || mediaType === 'video') && (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            <input className="lf-input" placeholder={`Public ${mediaType} URL (Meta requires a reachable HTTPS link)`} value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
            {mediaType === 'document' && (
              <input className="lf-input" placeholder="Filename (e.g. brochure.pdf)" value={mediaFilename} onChange={(e) => setMediaFilename(e.target.value)} />
            )}
          </div>
        )}
      </div>

      {bulkMode && (
        <div className="lf-alert lf-alert-info" style={{ marginBottom: 12 }}>
          🎯 <strong>Bulk Campaign Mode</strong> — Only selected {contactsOnlyMode ? 'contacts' : 'leads'} are shown.
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        {!bulkMode && (
          <>
            <select
              className="scraper-input"
              style={{ width: 140 }}
              value={scoreFilter}
              onChange={(e) => setScoreFilter(e.target.value as 'all' | 'hot' | 'warm' | 'cold')}
            >
              <option value="all">All Leads</option>
              <option value="hot">🔥 Hot Leads</option>
              <option value="warm">🌤 Warm Leads</option>
              <option value="cold">❄ Cold Leads</option>
            </select>
            <input
              className="scraper-input"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="Search leads by name, city, or niche…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </>
        )}
        <span className="lf-pill">{selectedLeads.length} selected</span>
        {selectedLeads.length > MAX_BATCH && <span className="lf-pill lf-pill-warn">max {MAX_BATCH}</span>}
        <button className="scraper-search-btn" style={{ background: '#64748b' }} onClick={() => setShowPreview((s) => !s)} disabled={busy || message.trim() === '' || selectedLeads.length === 0}>
          {showPreview ? 'Hide Preview' : 'Preview before sending'}
        </button>
        <button className="scraper-search-btn" style={{ background: '#0ea5e9' }} onClick={() => void sendTestMessage()} disabled={busy || selectedLeads.length === 0 || !configured}>
          Test message
        </button>
        <button
          className="scraper-search-btn"
          style={{ background: '#a78bfa' }}
          disabled={busy || selectedLeads.length === 0}
          onClick={async () => {
            try {
              await controlWhatsAppCampaign('schedule', {
                scheduledAt: new Date(Date.now() + 3600000).toISOString(),
                total: selectedLeads.length,
              });
              setError(null);
              setBulkResult({ sent: 0, failed: 0, skipped: 0, total: selectedLeads.length, testMode: false, results: [{ status: 'scheduled', message: 'Scheduled for +1 hour — open Campaigns to pause/cancel' }] } as unknown as WhatsAppBulkResponse);
            } catch (err) {
              setError(errMessage(err, 'Schedule failed'));
            }
          }}
        >
          Schedule later
        </button>
        <button className="scraper-search-btn" onClick={sendCampaign} disabled={campaignDisabled}>
          {busy ? 'Sending…' : previewMode ? 'Send with Preview' : 'Send immediately'}
        </button>
      </div>

      {showPreview && selectedLeads.length > 0 && (
        <div style={{ marginBottom: 14, background: 'rgba(15,23,42,0.5)', border: '1px solid var(--lf-card-border)', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--lf-text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Message Preview</div>
          {(() => {
            const lead = selectedLeads[0];
            return (
              <div style={{ marginBottom: 10, padding: 10, background: 'rgba(15,23,42,0.6)', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
                <div style={{ fontSize: 11, color: '#22d3ee', marginBottom: 4 }}>To: {lead.name || lead.phone} ({lead.city || '—'})</div>
                {imageAttachment && (
                  <div style={{ marginBottom: 8 }}>
                    <img src={imageAttachment.dataUrl} alt="Campaign" style={{ maxHeight: 100, borderRadius: 6, border: '1px solid var(--lf-card-border)' }} />
                  </div>
                )}
                {renderPreview(lead)}
              </div>
            );
          })()}
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: 8, fontSize: 13 }}>
            <strong style={{ color: '#22d3ee' }}>Selected Recipients:</strong>
            <span style={{ marginLeft: 8 }}>✓ {selectedLeads.length} {contactsOnlyMode ? 'Contact' : 'Lead'}{selectedLeads.length !== 1 ? 's' : ''} Selected</span>
          </div>
        </div>
      )}

      {draftLoaded && (
        <div className="lf-alert lf-alert-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>📝 Draft restored from previous session.</span>
          <button className="lf-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={clearDraft}>Clear Draft</button>
        </div>
      )}
      {error && <div className="lf-alert lf-alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {bulkResult && (
        <div className="lf-alert lf-alert-success" style={{ marginBottom: 12 }}>
          {bulkResult.sent} sent · {bulkResult.failed} failed · {bulkResult.skipped || 0} skipped (of {bulkResult.total}).
          {(bulkResult as any).previewSent && (
            <span style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              ✅ Preview copy sent to your account.
            </span>
          )}
        </div>
      )}

      {/* Lead table */}
      <div className="lf-card lf-table-wrap" style={{ padding: 0 }}>
        <table className="lf-table">
          <thead>
            <tr>
              <th className="lf-row-check"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
              <th>Name</th><th>Phone</th><th>City</th><th>Niche</th><th>Score</th><th>Status</th><th>Last Msg</th><th>Last Reply</th><th>Next F/U</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredLeads.length === 0 ? (
              <tr><td colSpan={11} className="lf-muted" style={{ textAlign: 'center', padding: 24 }}>
                {contactsOnlyMode ? 'No selected contacts with phone numbers.' : leads.length === 0 ? 'No recipients yet. Select leads on the Lead Page, then open WhatsApp CRM.' : scoreFilter !== 'all' ? `No ${scoreFilter} leads with phone numbers.` : pipelineFilter ? `No leads in "${pipelineFilter}" stage.` : 'No transferred leads with phone numbers.'}
              </td></tr>
            ) : (
              filteredLeads.map((l) => {
                const c = campaignMap.get(l.id);
                const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleDateString() : '—';
                return (
                <tr key={l.id}>
                  <td className="lf-row-check">
                    <input type="checkbox" checked={Boolean(selected[l.id])} onChange={(e) => setSelected((s) => ({ ...s, [l.id]: e.target.checked }))} aria-label={`Select ${l.name || l.id}`} />
                  </td>
                  <td>{l.name || '—'}</td>
                  <td>{l.phone || '—'}</td>
                  <td>{l.city || '—'}</td>
                  <td>{l.niche || '—'}</td>
                  <td>{scoreBadge(l.id)}</td>
                  <td>{statusBadge(l.id)}</td>
                  <td style={{ fontSize: 11, color: 'var(--lf-text-secondary)' }}>{fmtDate(c?.sentAt)}</td>
                  <td style={{ fontSize: 11, color: 'var(--lf-text-secondary)' }}>{fmtDate(c?.repliedAt)}</td>
                  <td style={{ fontSize: 11, color: 'var(--lf-text-secondary)' }}>{fmtDate(c?.followUp1At)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button onClick={() => markStatus(l.id, 'interested')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #fbbf24', background: '#fbbf2420', color: '#fbbf24', cursor: 'pointer', whiteSpace: 'nowrap' }}>★ Interested</button>
                      <button onClick={() => markStatus(l.id, 'meeting')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #f472b6', background: '#f472b620', color: '#f472b6', cursor: 'pointer', whiteSpace: 'nowrap' }}>📅 Meeting</button>
                      <button onClick={() => markStatus(l.id, 'deal')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #34d399', background: '#34d39920', color: '#34d399', cursor: 'pointer', whiteSpace: 'nowrap' }}>🏆 Deal</button>
                      <button onClick={() => markStatus(l.id, 'lost')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #64748b', background: '#64748b20', color: '#64748b', cursor: 'pointer', whiteSpace: 'nowrap' }}>✕ Lost</button>
                    </div>
                  </td>
                </tr>
              );})
            )}
          </tbody>
        </table>
      </div>

      {templates.length > 0 && (
        <p className="lf-muted" style={{ fontSize: 12, marginTop: 12 }}>
          Approved templates: {templates.map((t) => t.name).join(', ')}
        </p>
      )}
    </div>
  );
}
