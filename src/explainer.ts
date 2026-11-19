/** Reviewed bilingual glossary for readers outside Puerto Rico.
 *
 * Curated entries only. Matching is deterministic and uses the headline and
 * excerpt already on the card. It does not fetch the article, call a model,
 * or write a ledger. A closed <details> control is rendered only when an
 * entry matches. Sources were checked on VERIFIED_ON.
 */
export const VERIFIED_ON = '2026-11-19';
export const MAX_MATCHES = 3;

export type ExplainerLang = 'es' | 'en';

type Copy = { title: string; body: string[] };
type Source = { es: string; en: string; url: string };
type Entry = {
  id: string;
  priority: number;
  any: RegExp[];
  weak?: RegExp[];
  context?: RegExp[];
  /** Drops a weak match. A strong `any` match still counts. */
  weakBlock?: RegExp[];
  /** Drops the entry even when a strong pattern matched. */
  veto?: RegExp[];
  /** Case-sensitive acronyms, tested on the original card text. */
  acronyms?: RegExp[];
  /** Hide this entry when a more specific one already matched. */
  suppressIf?: string[];
  es: Copy;
  en: Copy;
  sources: Source[];
};

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const word = (inner: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${inner})(?![\\p{L}\\p{N}])`, 'iu');
const has = (value: string) => new RegExp(value, 'iu');
const acronym = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}])${value}(?![\\p{L}\\p{N}])`, 'u');

const MEMBERSHIP_ES = 'Un titular que nombra a una persona y a un partido no prueba que esa persona milite en él. Esta nota no asigna afiliación.';
const MEMBERSHIP_EN = 'A headline that names a person and a party does not prove membership. This note assigns nobody to a party.';

const CEE_BALLOT = 'https://www.ceepur.org/EleccionesGenerales2024/docs/papeletas/Legislativa/Modelo_111leg_ADJUNTAS_17.pdf';
const CEE_GUIDE = 'https://ww2.ceepur.org/sites/ComisionEE/es-pr/Documents/Gu%C3%ADa%20de%20orientaci%C3%B3n%20estad%C3%ADstica%20-%20Elecciones%20Generales%202024.pdf';
const CEE_PD = 'https://ww2.ceepur.org/sites/ComisionEE/es-pr/Certificaciones/Inscripci%C3%B3n%20como%20partido%20pol%C3%ADtico%20de%20la%20agrupaci%C3%B3n%20de%20ciudadanos%20conocida%20como%20Proyecto%20Dignidad%20(PD).pdf';
const PROMESA_PDF = 'https://www.congress.gov/114/plaws/publ187/PLAW-114publ187.pdf';
const BOARD_EN = 'https://oversightboard.pr.gov/about-us';
const BOARD_ES = 'https://juntasupervision.pr.gov/sobre-nosotros/';
const CONSTITUTION_PDF = 'https://www.govinfo.gov/content/pkg/STATUTE-66/pdf/STATUTE-66-Pg327.pdf';
const LEGISLATURE = 'https://poderjudicial.pr/constitucion/articulo-iii/';
const INCENTIVES = 'https://bvirtualogp.pr.gov/ogp/Bvirtual/LeyesOrganicas/PDF/60-2019.pdf';
const P3 = 'https://www.p3.pr.gov/active-partnerships';

const ENTRIES: Entry[] = [
  {
    id: 'fomb',
    priority: 10,
    acronyms: [acronym('PROMESA'), acronym('FOMB'), acronym('JSAF')],
    any: [
      has('ley promesa'), has('promesa act'),
      has('financial oversight and management board'),
      has('junta de supervision y administracion financiera'),
      has('junta de supervision fiscal'),
      has('junta de control fiscal'),
      has('fiscal oversight board'),
      has('oversight board for puerto rico'),
      has('puerto rico oversight board'),
    ],
    es: {
      title: 'Junta de Supervisión y Administración Financiera',
      body: [
        'La ley federal PROMESA (Ley Pública 114-187, 30 de junio de 2016) creó la Financial Oversight and Management Board para Puerto Rico. En español la Junta se llama Junta de Supervisión y Administración Financiera para Puerto Rico. Su página dice que la forman siete miembros nombrados por el presidente de Estados Unidos y un miembro ex officio designado por el gobernador.',
        '“Junta de Control Fiscal” y “Junta de Supervisión Fiscal” son nombres de uso público para esa misma Junta, no un segundo organismo. No es una comisión del Senado o de la Cámara, no es la Junta de Planificación y no es la junta de directores de una empresa. Esta nota no dice quiénes son los miembros hoy ni a qué partido pertenece un funcionario.',
      ],
    },
    en: {
      title: 'Financial Oversight and Management Board',
      body: [
        'The federal statute PROMESA (Public Law 114-187, June 30, 2016) established the Financial Oversight and Management Board for Puerto Rico. The Board’s Spanish name is Junta de Supervisión y Administración Financiera para Puerto Rico. Its own page says it has seven members appointed by the President of the United States and one ex officio member designated by the Governor of Puerto Rico.',
        '“Junta de Control Fiscal” and “Junta de Supervisión Fiscal” are public names for that same Board, not a second institution. It is not a committee of the Puerto Rico Senate or House, not the Planning Board (Junta de Planificación), and not a company’s board of directors. This note does not name current members or assign an official to a party.',
      ],
    },
    sources: [
      { es: 'Congreso de EE. UU., Ley Pública 114-187 (PDF)', en: 'U.S. Congress, Public Law 114-187 (PDF)', url: PROMESA_PDF },
      { es: 'Junta, Sobre nosotros', en: 'Oversight Board, About Us', url: BOARD_EN },
      { es: 'Junta, Sobre nosotros (español)', en: 'Junta, Sobre nosotros (Spanish)', url: BOARD_ES },
    ],
  },
  {
    id: 'oversight-committee',
    priority: 20,
    any: [
      has('oversight committee'),
      has('comite de supervision'),
      has('comision de supervision'),
    ],
    veto: [
      has('school board'), has('junta escolar'), has('board of directors'), has('junta de directores'),
    ],
    es: {
      title: '“Comité de supervisión” no es el nombre de la Junta',
      body: [
        '“Oversight committee”, “comité de supervisión” y “comisión de supervisión” no son el nombre legal de la Junta de Supervisión y Administración Financiera. Una comisión del Senado o de la Cámara de Puerto Rico es un órgano interno de esa cámara. El Congreso de Estados Unidos también tiene comités.',
        'El titular y el extracto de esta tarjeta no bastan para decidir de qué organismo se habla. Si también nombran a PROMESA o a la Junta, esa entrada va aparte.',
      ],
    },
    en: {
      title: '“Oversight committee” is not the Board’s name',
      body: [
        '“Oversight committee,” “comité de supervisión,” and “comisión de supervisión” are not the statutory name of the Financial Oversight and Management Board. A committee of the Puerto Rico Senate or House is an internal body of that chamber. The United States Congress has committees too.',
        'The headline and excerpt on this card do not decide which body is meant. If they also name PROMESA or the Board, that entry is separate.',
      ],
    },
    sources: [
      { es: 'Congreso de EE. UU., Ley Pública 114-187 (PDF)', en: 'U.S. Congress, Public Law 114-187 (PDF)', url: PROMESA_PDF },
      { es: 'Constitución de Puerto Rico, Artículo III', en: 'Constitution of Puerto Rico, Article III', url: LEGISLATURE },
    ],
  },
  {
    id: 'planning',
    priority: 30,
    any: [has('junta de planificacion'), has('puerto rico planning board')],
    weak: [has('planning board')],
    context: [has('puerto rico'), has('junta de planificacion')],
    es: {
      title: 'Junta de Planificación',
      body: [
        'La Junta de Planificación no es la Junta de Supervisión y Administración Financiera. El nombre oficial en español de la junta creada por PROMESA es Junta de Supervisión y Administración Financiera para Puerto Rico.',
        'Esta nota solo evita confundir los nombres. No describe un permiso ni un mapa, y no cita aquí una ley orgánica de la Junta de Planificación.',
      ],
    },
    en: {
      title: 'Planning Board',
      body: [
        'The Planning Board (Junta de Planificación) is not the Financial Oversight and Management Board. The Board created by PROMESA uses the Spanish name Junta de Supervisión y Administración Financiera para Puerto Rico.',
        'This note only keeps the names apart. It does not describe a permit or a map, and it does not cite an organic statute for the Planning Board.',
      ],
    },
    sources: [
      { es: 'Junta, Sobre nosotros (español)', en: 'Junta, Sobre nosotros (Spanish)', url: BOARD_ES },
    ],
  },
  {
    id: 'legislature',
    priority: 40,
    any: [
      has('asamblea legislativa'),
      has('legislative assembly'),
      has('senado de puerto rico'),
      has('puerto rico senate'),
      has('camara de representantes'),
      has('comision del senado'),
      has('comision senatorial'),
      has('comision cameral'),
      word('senado'), word('senador'), word('senadores'),
    ],
    veto: [
      has('senado de estados unidos'), has('senado federal'), has('senado estadounidense'),
      has('senador federal'), has('senador estadounidense'), has('senadores federales'),
      has('united states senate'), has('u.s. senate'), has('us senate'), has('u.s. senator'),
    ],
    es: {
      title: 'Asamblea Legislativa',
      body: [
        'El Artículo III de la Constitución de Puerto Rico dice que el poder legislativo lo ejerce una Asamblea Legislativa de dos cámaras, el Senado y la Cámara de Representantes, elegidas por voto directo. El mismo artículo fija 27 senadores y 51 representantes, salvo el aumento previsto en su Sección 7.',
        'Una comisión de esas cámaras no es la Junta federal de PROMESA. “Senado” a veces se refiere al Senado de Estados Unidos; si el texto lo dice, esta nota no se usa.',
      ],
    },
    en: {
      title: 'Legislative Assembly',
      body: [
        'Article III of the Constitution of Puerto Rico vests legislative power in a Legislative Assembly of two houses, the Senate and the House of Representatives, elected by direct vote. The same article sets 27 senators and 51 representatives, unless Section 7 increases that number.',
        'A committee of those houses is not the federal Board created by PROMESA. “Senate” sometimes means the United States Senate; when the text says so, this note stays off.',
      ],
    },
    sources: [
      { es: 'Poder Judicial, Constitución, Artículo III', en: 'Puerto Rico Judiciary, Constitution, Article III', url: LEGISLATURE },
    ],
  },
  {
    id: 'pnp',
    priority: 50,
    any: [word('pnp'), has('partido nuevo progresista'), has('new progressive party')],
    es: {
      title: 'Partido Nuevo Progresista (PNP)',
      body: [
        'El PNP aparece como columna de partido en la papeleta modelo de la Comisión Estatal de Elecciones para las elecciones generales del 5 de noviembre de 2024. En su página “Estadidad”, el partido presenta la estadidad como el estatus que quiere adelantar. Eso es una declaración del partido, no una descripción de la ley vigente.',
        MEMBERSHIP_ES,
      ],
    },
    en: {
      title: 'New Progressive Party (PNP)',
      body: [
        'The PNP is a party column on the State Elections Commission’s model ballot for the November 5, 2024 general election. On its “Estadidad” page, the party presents statehood as the status it wants to advance. That is the party’s statement, not a description of current law.',
        MEMBERSHIP_EN,
      ],
    },
    sources: [
      { es: 'CEE, papeleta modelo legislativa 2024 (PDF)', en: 'CEE, 2024 model legislative ballot (PDF)', url: CEE_BALLOT },
      { es: 'PNP, página “Estadidad” (declaración del partido)', en: 'PNP, “Estadidad” page (party statement)', url: 'https://pnppr.com/estadidad/' },
    ],
  },
  {
    id: 'ppd',
    priority: 60,
    any: [word('ppd'), has('partido popular democratico'), has('popular democratic party')],
    es: {
      title: 'Partido Popular Democrático (PPD)',
      body: [
        'El PPD aparece como columna de partido en la papeleta modelo de la Comisión Estatal de Elecciones para las elecciones generales del 5 de noviembre de 2024. Este glosario no resume una plataforma de estatus del PPD porque no usa un documento del partido para eso.',
        MEMBERSHIP_ES,
      ],
    },
    en: {
      title: 'Popular Democratic Party (PPD)',
      body: [
        'The PPD is a party column on the State Elections Commission’s model ballot for the November 5, 2024 general election. This glossary does not summarize a PPD status platform, because no party document was used for one.',
        MEMBERSHIP_EN,
      ],
    },
    sources: [
      { es: 'CEE, papeleta modelo legislativa 2024 (PDF)', en: 'CEE, 2024 model legislative ballot (PDF)', url: CEE_BALLOT },
    ],
  },
  {
    id: 'pip',
    priority: 70,
    any: [word('pip'), has('partido independentista puertorriqueno'), has('puerto rican independence party')],
    es: {
      title: 'Partido Independentista Puertorriqueño (PIP)',
      body: [
        'El sitio del PIP dice que el partido se fundó el 20 de octubre de 1946 para luchar por la independencia de Puerto Rico y la justicia social. Esa es la versión del partido. La papeleta modelo de la CEE para 2024 también incluye el nombre.',
        MEMBERSHIP_ES,
      ],
    },
    en: {
      title: 'Puerto Rican Independence Party (PIP)',
      body: [
        'The PIP’s site says the party was founded on October 20, 1946, to seek the independence of Puerto Rico and social justice. That is the party’s account. The CEE’s 2024 model ballot also carries the name.',
        MEMBERSHIP_EN,
      ],
    },
    sources: [
      { es: 'PIP, sitio del partido', en: 'PIP, party site', url: 'https://partidoindependentista.com/' },
      { es: 'CEE, papeleta modelo legislativa 2024 (PDF)', en: 'CEE, 2024 model legislative ballot (PDF)', url: CEE_BALLOT },
    ],
  },
  {
    id: 'mvc',
    priority: 80,
    any: [word('mvc'), has('movimiento victoria ciudadana'), has('victoria ciudadana')],
    es: {
      title: 'Movimiento Victoria Ciudadana (MVC)',
      body: [
        'El MVC aparece como partido en la papeleta modelo de la CEE para las elecciones generales de 2024 y en la guía estadística de esa elección. Este glosario no describe su plataforma.',
        MEMBERSHIP_ES,
      ],
    },
    en: {
      title: 'Movimiento Victoria Ciudadana (MVC)',
      body: [
        'The MVC appears as a party on the CEE’s 2024 model ballot and in that election’s statistical guide. This glossary does not describe its platform.',
        MEMBERSHIP_EN,
      ],
    },
    sources: [
      { es: 'CEE, papeleta modelo legislativa 2024 (PDF)', en: 'CEE, 2024 model legislative ballot (PDF)', url: CEE_BALLOT },
      { es: 'CEE, guía estadística de las elecciones de 2024 (PDF)', en: 'CEE, 2024 statistical guide (PDF)', url: CEE_GUIDE },
    ],
  },
  {
    id: 'pd',
    priority: 90,
    any: [has('proyecto dignidad'), has('project dignity')],
    es: {
      title: 'Proyecto Dignidad',
      body: [
        'La Comisión Estatal de Elecciones certificó a Proyecto Dignidad como partido por petición el 22 de enero de 2020. La papeleta modelo de 2024 todavía lo lista. Este glosario no describe su plataforma. Las letras “PD” solas no activan esta nota.',
        MEMBERSHIP_ES,
      ],
    },
    en: {
      title: 'Proyecto Dignidad',
      body: [
        'The State Elections Commission certified Proyecto Dignidad as a petition party on January 22, 2020. The 2024 model ballot still lists it. This glossary does not describe its platform. The letters “PD” alone do not open this note.',
        MEMBERSHIP_EN,
      ],
    },
    sources: [
      { es: 'CEE, certificación de Proyecto Dignidad, 22 de enero de 2020 (PDF)', en: 'CEE, Proyecto Dignidad certification, January 22, 2020 (PDF)', url: CEE_PD },
      { es: 'CEE, papeleta modelo legislativa 2024 (PDF)', en: 'CEE, 2024 model legislative ballot (PDF)', url: CEE_BALLOT },
    ],
  },
  {
    id: 'cee',
    priority: 100,
    any: [has('comision estatal de elecciones'), has('state elections commission'), word('ceepur')],
    weak: [word('cee')],
    context: [has('eleccion'), has('electoral'), has('voto'), has('papeleta'), has('election'), has('ballot')],
    es: {
      title: 'Comisión Estatal de Elecciones',
      body: [
        'La Comisión Estatal de Elecciones (CEE) es el organismo que administra las elecciones de Puerto Rico y certifica partidos. Los documentos de 2020 y 2024 citados en este glosario son de la Comisión.',
        'Esta nota no da resultados ni dice quién ganó.',
      ],
    },
    en: {
      title: 'State Elections Commission',
      body: [
        'The Comisión Estatal de Elecciones (CEE) administers Puerto Rico elections and certifies parties. The 2020 and 2024 documents cited in this glossary are Commission documents.',
        'This note does not report results or say who won.',
      ],
    },
    sources: [
      { es: 'CEE, guía estadística de las elecciones de 2024 (PDF)', en: 'CEE, 2024 statistical guide (PDF)', url: CEE_GUIDE },
    ],
  },
  {
    id: 'status-ela',
    priority: 110,
    any: [has('estado libre asociado'), has('commonwealth of puerto rico')],
    weak: [word('commonwealth')],
    context: [has('puerto rico')],
    weakBlock: [
      has('commonwealth games'), has('commonwealth of nations'), has('british commonwealth'),
      has('commonwealth of massachusetts'), has('commonwealth of pennsylvania'),
      has('commonwealth of virginia'), has('commonwealth of kentucky'),
    ],
    es: {
      title: 'Estado Libre Asociado',
      body: [
        'La Ley Pública 447, del 3 de julio de 1952, aprobó la constitución del Commonwealth of Puerto Rico, adoptada por el electorado el 3 de marzo de 1952. En español ese nombre constitucional es Estado Libre Asociado.',
        'Los partidos discrepan sobre si esa relación debe seguir, convertirse en estadidad o convertirse en independencia. Esta nota no elige bando y no dice qué concluye la noticia.',
      ],
    },
    en: {
      title: 'Commonwealth / Estado Libre Asociado',
      body: [
        'Public Law 447, July 3, 1952, approved the constitution of the Commonwealth of Puerto Rico, which voters had adopted on March 3, 1952. In Spanish that constitutional name is Estado Libre Asociado.',
        'Parties disagree about whether this relationship should remain, become statehood, or become independence. This note does not take a side and does not say what the story concludes.',
      ],
    },
    sources: [
      { es: 'govinfo, 66 Stat. 327, Ley Pública 447 (PDF)', en: 'govinfo, 66 Stat. 327, Public Law 447 (PDF)', url: CONSTITUTION_PDF },
    ],
  },
  {
    id: 'status-statehood',
    priority: 120,
    any: [word('estadidad')],
    weak: [word('statehood')],
    context: [has('puerto rico')],
    suppressIf: ['pnp'],
    es: {
      title: 'Estadidad',
      body: [
        'Estadidad, en este contexto, significa la propuesta de que Puerto Rico sea un estado de Estados Unidos. Es una posición política, no una descripción de la ley vigente. La constitución aprobada en 1952 es la del Estado Libre Asociado.',
        'Esta nota no dice quién apoya la estadidad, salvo cuando otra entrada cita un documento de un partido, y no dice qué resulta de un plebiscito.',
      ],
    },
    en: {
      title: 'Statehood',
      body: [
        'Statehood, in this context, means the proposal that Puerto Rico become a U.S. state. It is a political position, not a description of current law. The constitution approved in 1952 is the Commonwealth constitution.',
        'This note does not say who supports statehood, except where another entry cites a party document, and it does not say what a plebiscite decided.',
      ],
    },
    sources: [
      { es: 'govinfo, 66 Stat. 327, Ley Pública 447 (PDF)', en: 'govinfo, 66 Stat. 327, Public Law 447 (PDF)', url: CONSTITUTION_PDF },
    ],
  },
  {
    id: 'status-independence',
    priority: 130,
    any: [],
    weak: [word('independencia'), word('independence')],
    context: [has('puerto rico'), has('estatus'), has('plebiscito'), has('soberan'), has('estadidad'), has('estado libre'), has('descolon'), has('colonial'), has('independentista')],
    weakBlock: [
      has('independencia energet'), has('energy independence'), has('independencia judicial'),
      has('judicial independence'), has('independencia de la prensa'), has('freedom of the press'),
    ],
    suppressIf: ['pip'],
    es: {
      title: 'Independencia',
      body: [
        'En una noticia de estatus, independencia suele significar la propuesta de un Puerto Rico separado de Estados Unidos. También puede significar otra cosa, como independencia energética o judicial; en esos casos esta nota no aparece.',
        'Es una posición política, no un hecho sobre el desenlace de la noticia. Esta nota no dice quién la apoya, salvo la entrada del PIP cuando el texto nombra a ese partido.',
      ],
    },
    en: {
      title: 'Independence',
      body: [
        'In a status story, independence usually means the proposal of a Puerto Rico separate from the United States. The word can mean something else, such as energy or judicial independence; those cases do not open this note.',
        'It is a political position, not a finding about how the story comes out. This note does not say who supports it, except the PIP entry when the text names that party.',
      ],
    },
    sources: [
      { es: 'govinfo, 66 Stat. 327, Ley Pública 447 (PDF)', en: 'govinfo, 66 Stat. 327, Public Law 447 (PDF)', url: CONSTITUTION_PDF },
    ],
  },
  {
    id: 'resident-commissioner',
    priority: 140,
    any: [has('comisionado residente'), has('comisionada residente'), has('resident commissioner')],
    es: {
      title: 'Comisionado residente',
      body: [
        'La guía estadística de la CEE para 2024 trata al gobernador y al comisionado residente como cargos electivos para los que los partidos presentan peticiones de endoso. Esta nota no describe el voto de ese cargo en el Congreso, porque no cita aquí el estatuto federal, y no dice quién lo ocupa.',
      ],
    },
    en: {
      title: 'Resident Commissioner',
      body: [
        'The CEE’s 2024 statistical guide treats the governor and the resident commissioner as elective offices for which parties file endorsement petitions. This note does not describe that office’s vote in Congress, because it does not cite the federal statute here, and it does not say who holds the office.',
      ],
    },
    sources: [
      { es: 'CEE, guía estadística de las elecciones de 2024 (PDF)', en: 'CEE, 2024 statistical guide (PDF)', url: CEE_GUIDE },
    ],
  },
  {
    id: 'act60',
    priority: 150,
    any: [
      has('codigo de incentivos'),
      has('incentives code'),
      has('ley (?:num(?:ero)?\\.?\\s*)?60-2019'),
      has('ley (?:num(?:ero)?\\.?\\s*)?60 de 2019'),
      has('act 60-2019'),
      has('act 60 of 2019'),
    ],
    weak: [has('ley (?:num(?:ero)?\\.?\\s*)?60(?!\\d)'), has('act 60(?!\\d)')],
    context: [has('incentiv'), has('decreto'), has('contribuyente'), has('exencion contributiva'), has('tax exemption')],
    weakBlock: [has('transito'), has('traffic'), has('vehic')],
    es: {
      title: 'Código de Incentivos (Ley 60-2019)',
      body: [
        'La Ley Núm. 60 de 1 de julio de 2019 es el Código de Incentivos de Puerto Rico. La Oficina de Gerencia y Presupuesto publica una compilación revisada el 16 de julio de 2026 que indica que la ley está enmendada. Esta nota no lista tasas ni dice quién cualifica.',
        'Hay otras leyes número 60. Por eso la nota solo sale si el texto apunta a este código.',
      ],
    },
    en: {
      title: 'Incentives Code (Act 60-2019)',
      body: [
        'Act No. 60 of July 1, 2019, is the Puerto Rico Incentives Code. The Office of Management and Budget publishes a compilation revised July 16, 2026, and marked as amended. This note does not list rates or say who qualifies.',
        'Other statutes are also numbered 60. The note appears only when the text points to this code.',
      ],
    },
    sources: [
      { es: 'OGP, Código de Incentivos, Ley 60-2019 compilada (PDF)', en: 'OGP, Incentives Code, compiled Act 60-2019 (PDF)', url: INCENTIVES },
    ],
  },
  {
    id: 'luma',
    priority: 160,
    any: [word('luma'), has('luma energy')],
    es: {
      title: 'LUMA',
      body: [
        'La Autoridad de Alianzas Público-Privadas lista a LUMA como operador del sistema de transmisión y distribución eléctrica, en un contrato de operación y mantenimiento por 15 años, con la AEE (PREPA) y la Autoridad como contrapartes públicas.',
        'La misma página describe pleitos sobre ese contrato, en palabras del gobierno. Esta nota no adopta esas alegaciones, no describe el servicio de hoy y no convierte a LUMA en la Junta de PROMESA.',
      ],
    },
    en: {
      title: 'LUMA',
      body: [
        'The Public-Private Partnerships Authority lists LUMA as the operator of the electric transmission and distribution system under a 15-year operation-and-maintenance contract, with PREPA (the Autoridad de Energía Eléctrica) and the Authority as the public counterparts.',
        'The same page describes contract disputes in the government’s words. This note does not adopt those allegations, does not describe today’s service, and does not make LUMA the PROMESA Board.',
      ],
    },
    sources: [
      { es: 'Autoridad de Alianzas Público-Privadas, alianzas activas', en: 'Public-Private Partnerships Authority, active partnerships', url: P3 },
    ],
  },
  {
    id: 'prepa',
    priority: 170,
    any: [word('prepa'), has('autoridad de energia electrica'), has('puerto rico electric power authority')],
    weak: [word('aee')],
    context: [has('energ'), has('electric'), has('luz'), has('prepa'), has('luma'), has('apagon')],
    suppressIf: ['luma'],
    es: {
      title: 'AEE (PREPA)',
      body: [
        'Cuando la tarjeta nombra a la AEE o a PREPA y no nombra a LUMA, se refiere a la Autoridad de Energía Eléctrica, la contraparte pública que la Autoridad de Alianzas identifica en el contrato de transmisión y distribución.',
        'No es LUMA y no es la Junta de PROMESA. Esta nota no explica generación, tarifas ni la causa de una avería.',
      ],
    },
    en: {
      title: 'PREPA (AEE)',
      body: [
        'When the card names PREPA or the Autoridad de Energía Eléctrica and does not name LUMA, it is the public power authority that the Partnerships Authority lists on the transmission-and-distribution contract.',
        'It is not LUMA and it is not the PROMESA Board. This note does not explain generation, rates, or the cause of an outage.',
      ],
    },
    sources: [
      { es: 'Autoridad de Alianzas Público-Privadas, alianzas activas', en: 'Public-Private Partnerships Authority, active partnerships', url: P3 },
    ],
  },
  {
    id: 'aaa',
    priority: 180,
    any: [has('autoridad de acueductos y alcantarillados'), has('acueductos y alcantarillados')],
    weak: [word('aaa')],
    context: [has('agua'), has('water'), has('acueducto'), has('alcantarillado'), has('potable'), has('salidero')],
    weakBlock: [has('beisbol'), has('baseball'), has('triple-a'), has('triple a'), word('liga'), has('battery'), has('bateria')],
    es: {
      title: 'Autoridad de Acueductos y Alcantarillados',
      body: [
        'La AAA es la corporación pública cuyo portal describe el servicio de agua y alcantarillado de Puerto Rico. Las letras AAA también nombran otras cosas, entre ellas ligas de béisbol, así que hacen falta el nombre completo o palabras de servicio de agua.',
        'No es la utilidad eléctrica y no es la Junta de PROMESA.',
      ],
    },
    en: {
      title: 'Aqueduct and Sewer Authority',
      body: [
        'The AAA is the public corporation whose site describes Puerto Rico water and sewer service. The letters AAA also name other things, including baseball leagues, so the full name or water-service wording is required.',
        'It is not the electric utility and it is not the PROMESA Board.',
      ],
    },
    sources: [
      { es: 'Portal de la AAA', en: 'AAA public site', url: 'https://www.acueductos.pr.gov/' },
    ],
  },
  {
    id: 'hacienda',
    priority: 190,
    any: [has('departamento de hacienda')],
    weak: [has('department of the treasury')],
    context: [has('puerto rico')],
    es: {
      title: 'Departamento de Hacienda',
      body: [
        'El Departamento de Hacienda es el departamento de tesoro de Puerto Rico. Su sitio es hacienda.pr.gov. La palabra “hacienda” sola puede ser una finca o un apellido, así que esta nota exige el nombre del departamento.',
        'No explica una planilla y no es el Departamento del Tesoro de Estados Unidos salvo que el texto lo diga.',
      ],
    },
    en: {
      title: 'Puerto Rico Treasury Department',
      body: [
        'Departamento de Hacienda is the Puerto Rico Treasury Department. Its site is hacienda.pr.gov. The word “hacienda” alone can be an estate or a surname, so this note requires the department’s name.',
        'It does not explain a tax return, and it is not the United States Treasury unless the text says so.',
      ],
    },
    sources: [
      { es: 'Departamento de Hacienda', en: 'Puerto Rico Treasury Department', url: 'https://hacienda.pr.gov/' },
    ],
  },
];

function entryMatches(entry: Entry, original: string, folded: string): boolean {
  if (entry.veto?.some(pattern => pattern.test(folded))) return false;
  if (entry.acronyms?.some(pattern => pattern.test(original))) return true;
  if (entry.any.some(pattern => pattern.test(folded))) return true;
  if (!entry.weak?.some(pattern => pattern.test(folded))) return false;
  if (entry.context && !entry.context.some(pattern => pattern.test(folded))) return false;
  if (entry.weakBlock?.some(pattern => pattern.test(folded))) return false;
  return true;
}

/** Stable ids for the glossary hits in `text`, highest priority first. */
export function matchExplainer(text: string): string[] {
  const folded = fold(text);
  const hits = ENTRIES.filter(entry => entryMatches(entry, text, folded));
  const ids = new Set(hits.map(entry => entry.id));
  return hits
    .filter(entry => !entry.suppressIf?.some(id => ids.has(id)))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(entry => entry.id);
}

export function explainerCitations(): { id: string; url: string }[] {
  return ENTRIES.flatMap(entry => entry.sources.map(source => ({ id: entry.id, url: source.url })));
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!
));

/** Closed disclosure for the view language, or '' when nothing on the card matches. */
export function explainerHtml(text: string, lang: ExplainerLang): string {
  const ids = matchExplainer(text);
  if (!ids.length) return '';
  const shown = ids.slice(0, MAX_MATCHES).map(id => ENTRIES.find(entry => entry.id === id)!);
  const extra = ids.length - shown.length;
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  const entries = shown.map(entry => {
    const copy = entry[lang];
    const sources = entry.sources.map(source =>
      `<li><a href="${escape(source.url)}" rel="noopener noreferrer">${escape(source[lang])}</a></li>`,
    ).join('');
    return `<section class="explainer-entry"><h4>${escape(copy.title)}</h4>${copy.body.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}<ul class="explainer-sources">${sources}</ul></section>`;
  }).join('');
  const more = extra > 0 ? `<p class="explainer-more">${escape(t('Hay otras entradas del glosario en esta tarjeta. Se muestran tres.', 'This card matched more glossary entries. Three are shown.'))}</p>` : '';
  const banner = t(
    'Contexto de un glosario revisado. Sale solo si el titular o el extracto de esta tarjeta menciona una entrada. No resume el artículo, no usa el texto completo y no asigna a nadie a un partido.',
    'Context from a reviewed glossary. It appears only when this card’s headline or excerpt mentions an entry. It does not summarize the article, it does not use the full story, and it does not assign anyone to a party.',
  );
  const checked = t(
    'Fuentes públicas revisadas el 19 de noviembre de 2026. Esto es contexto, no el reportaje.',
    'Public sources checked on November 19, 2026. This is background, not the reporting.',
  );
  return `<details class="explainer" data-explainer="${escape(shown.map(entry => entry.id).join(','))}"><summary>${escape(t('Explicar el contexto', 'Explain the context'))}</summary><div class="explainer-body" lang="${lang}"><p class="explainer-banner">${escape(banner)}</p>${entries}${more}<p class="explainer-checked">${escape(checked)}</p></div></details>`;
}
