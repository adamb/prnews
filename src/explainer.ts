/** Reviewed bilingual glossary for readers outside Puerto Rico.
 *
 * Curated entries only. Matching is deterministic and uses the headline and
 * excerpt already on the card. It does not fetch the article, call a model,
 * or write a ledger. A closed <details> control labeled "Contexto"/"Context"
 * renders only when an entry matches. Each entry is about two sentences and
 * links the public source it relies on. Sources were checked on VERIFIED_ON;
 * statute PDFs and the PIP party site carry the 2026-11-19 check.
 */
export const VERIFIED_ON = '2026-11-20';
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

export const ENTRIES: Entry[] = [
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
        'La ley federal PROMESA (Ley Pública 114-187, 30 de junio de 2016) creó la Financial Oversight and Management Board, en español Junta de Supervisión y Administración Financiera para Puerto Rico, con siete miembros nombrados por el presidente de Estados Unidos y un miembro ex oficio designado por el gobernador.',
        '“Junta de Control Fiscal” y “Junta de Supervisión Fiscal” son nombres públicos de esa misma Junta; no es la Junta de Planificación ni una comisión del Senado o de la Cámara.',
      ],
    },
    en: {
      title: 'Financial Oversight and Management Board',
      body: [
        'The federal PROMESA statute (Public Law 114-187, June 30, 2016) created the Financial Oversight and Management Board — Junta de Supervisión y Administración Financiera para Puerto Rico, in Spanish — with seven members appointed by the President of the United States and one ex officio member designated by the Governor.',
        '“Junta de Control Fiscal” and “Junta de Supervisión Fiscal” are public names for that same Board; it is not the Planning Board and not a committee of the Senate or House.',
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
        '“Oversight committee” y “comité de supervisión” no son el nombre legal de la Junta de Supervisión y Administración Financiera; una comisión de supervisión suele ser un órgano interno del Senado, de la Cámara o del propio Congreso de Estados Unidos.',
        'Si el texto también nombra a PROMESA o a la Junta, esa entrada aparece aparte.',
      ],
    },
    en: {
      title: '“Oversight committee” is not the Board’s name',
      body: [
        '“Oversight committee” and “comité de supervisión” are not the statutory name of the Financial Oversight and Management Board; an oversight committee is usually an internal body of the Puerto Rico Senate, House, or the U.S. Congress itself.',
        'When the text also names PROMESA or the Board, that entry appears separately.',
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
        'La Junta de Planificación es un organismo del Gobierno de Puerto Rico, distinto de la Junta de Supervisión y Administración Financiera que creó la ley federal PROMESA.',
        'El nombre legal en español del organismo federal es Junta de Supervisión y Administración Financiera para Puerto Rico.',
      ],
    },
    en: {
      title: 'Planning Board',
      body: [
        'The Junta de Planificación (Planning Board) is a Puerto Rico government body, distinct from the Financial Oversight and Management Board created by the federal PROMESA statute.',
        'The federal Board’s legal Spanish name is Junta de Supervisión y Administración Financiera para Puerto Rico.',
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
        'El Artículo III de la Constitución de Puerto Rico pone el poder legislativo en una Asamblea Legislativa de dos cámaras —el Senado y la Cámara de Representantes— elegidas por voto directo, con 27 senadores y 51 representantes, salvo el aumento que permite su Sección 7.',
        'Una comisión de esas cámaras es un órgano interno suyo y no es la Junta federal de PROMESA.',
      ],
    },
    en: {
      title: 'Legislative Assembly',
      body: [
        'Article III of the Constitution of Puerto Rico vests legislative power in a Legislative Assembly of two houses — the Senate and the House of Representatives — elected by direct vote, with 27 senators and 51 representatives unless Section 7 adds members.',
        'A committee of those houses is an internal body and is not the federal Board created by PROMESA.',
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
        'El Partido Nuevo Progresista (PNP) aparece como columna de partido en la papeleta modelo de la Comisión Estatal de Elecciones para las elecciones generales del 5 de noviembre de 2024.',
        'En su página “Estadidad” el partido presenta la estadidad como el estatus que quiere adelantar; es su declaración, no una descripción de la ley vigente.',
      ],
    },
    en: {
      title: 'New Progressive Party (PNP)',
      body: [
        'The New Progressive Party (PNP) is a party column on the State Elections Commission’s model ballot for the November 5, 2024 general election.',
        'On its “Estadidad” page the party presents statehood as the status it wants to advance; that is the party’s statement, not a description of current law.',
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
        'El Partido Popular Democrático (PPD) aparece como columna de partido en la papeleta modelo de la Comisión Estatal de Elecciones para las elecciones generales del 5 de noviembre de 2024.',
      ],
    },
    en: {
      title: 'Popular Democratic Party (PPD)',
      body: [
        'The Popular Democratic Party (PPD) is a party column on the State Elections Commission’s model ballot for the November 5, 2024 general election.',
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
        'El Partido Independentista Puertorriqueño (PIP) aparece como columna de partido en la papeleta modelo de la Comisión Estatal de Elecciones para las elecciones generales de 2024.',
        'Su sitio dice que el partido se fundó el 20 de octubre de 1946 para luchar por la independencia de Puerto Rico y la justicia social; es la versión del propio partido.',
      ],
    },
    en: {
      title: 'Puerto Rican Independence Party (PIP)',
      body: [
        'The Puerto Rican Independence Party (PIP) is a party column on the State Elections Commission’s model ballot for the 2024 general election.',
        'The party’s own site says it was founded on October 20, 1946, to seek the independence of Puerto Rico and social justice.',
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
        'El Movimiento Victoria Ciudadana (MVC) aparece como partido en la papeleta modelo de la Comisión Estatal de Elecciones para las elecciones generales de 2024 y en la guía estadística de esa elección.',
      ],
    },
    en: {
      title: 'Movimiento Victoria Ciudadana (MVC)',
      body: [
        'The Movimiento Victoria Ciudadana (MVC) appears as a party on the State Elections Commission’s model ballot for the 2024 general election and in that election’s statistical guide.',
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
        'La Comisión Estatal de Elecciones certificó a Proyecto Dignidad como partido por petición el 22 de enero de 2020, y la papeleta modelo de 2024 todavía lo lista.',
      ],
    },
    en: {
      title: 'Proyecto Dignidad',
      body: [
        'The State Elections Commission certified Proyecto Dignidad as a petition party on January 22, 2020, and the 2024 model ballot still lists it.',
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
        'La Comisión Estatal de Elecciones (CEE) es el organismo que administra las elecciones de Puerto Rico y certifica a los partidos.',
        'Los documentos electorales citados en estas notas son de la Comisión.',
      ],
    },
    en: {
      title: 'State Elections Commission',
      body: [
        'The Comisión Estatal de Elecciones (CEE) administers Puerto Rico elections and certifies parties.',
        'The election documents cited in these notes are Commission documents.',
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
        'La Ley Pública 447, del 3 de julio de 1952, aprobó la constitución del Commonwealth of Puerto Rico —Estado Libre Asociado, en español—, adoptada por el electorado el 3 de marzo de 1952.',
        'Los partidos discrepan sobre si esa relación debe continuar, convertirse en estadidad o en independencia.',
      ],
    },
    en: {
      title: 'Commonwealth / Estado Libre Asociado',
      body: [
        'Public Law 447, July 3, 1952, approved the constitution of the Commonwealth of Puerto Rico — Estado Libre Asociado in Spanish — which voters had adopted on March 3, 1952.',
        'Parties disagree on whether that relationship should remain, become statehood, or become independence.',
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
        'Estadidad es la propuesta de que Puerto Rico sea un estado de Estados Unidos; es una posición política, no una descripción de la ley vigente.',
        'La constitución vigente es la del Estado Libre Asociado aprobada en 1952.',
      ],
    },
    en: {
      title: 'Statehood',
      body: [
        'Statehood, in this context, is the proposal that Puerto Rico become a U.S. state; it is a political position, not a description of current law.',
        'The constitution in force is the Commonwealth constitution approved in 1952.',
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
        'En una noticia de estatus, independencia suele significar la propuesta de un Puerto Rico separado de Estados Unidos, una posición política.',
        'La palabra también sirve para la independencia energética, judicial o de la prensa; en esos casos esta nota no aparece.',
      ],
    },
    en: {
      title: 'Independence',
      body: [
        'In a status story, independence usually means the proposal of a Puerto Rico separate from the United States, a political position.',
        'The word also covers energy, judicial, or press independence; those cases do not open this note.',
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
        'El estatuto federal 48 U.S.C. § 891 dispone que los electores calificados de Puerto Rico elijan un comisionado residente en Estados Unidos con un término de cuatro años que comienza el 3 de enero siguiente a la elección.',
        'Un informe del Servicio de Investigación del Congreso resume sus derechos en la Cámara de Representantes: puede votar en comisiones y, bajo las reglas recientes de la Cámara, en el Committee of the Whole con revotación automática si su voto es decisivo, pero no puede votar en el pleno.',
      ],
    },
    en: {
      title: 'Resident Commissioner',
      body: [
        'Federal statute 48 U.S.C. § 891 has the qualified electors of Puerto Rico choose a Resident Commissioner to the United States for a four-year term beginning the January 3 after the general election.',
        'A Congressional Research Service report summarizes the office’s standing in the House of Representatives: it can vote in committee and, under recent House rules, in the Committee of the Whole with an automatic revote when its vote is decisive, but not on the House floor.',
      ],
    },
    sources: [
      { es: 'Oficina del Código de EE. UU., 48 U.S.C. § 891', en: 'U.S. House Code office, 48 U.S.C. § 891', url: 'https://uscode.house.gov/us/usc/119-118/t48/s891/' },
      { es: 'CRS, derechos parlamentarios del comisionado residente (R40170)', en: 'CRS, parliamentary rights of the Resident Commissioner (R40170)', url: 'https://www.congress.gov/crs-product/R40170' },
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
        'La Ley Núm. 60 de 1 de julio de 2019 es el Código de Incentivos de Puerto Rico; la Oficina de Gerencia y Presupuesto publica la compilación de la ley enmendada.',
        'Hay otras leyes número 60, así que la nota solo sale cuando el texto apunta a este código.',
      ],
    },
    en: {
      title: 'Incentives Code (Act 60-2019)',
      body: [
        'Act No. 60 of July 1, 2019, is the Puerto Rico Incentives Code; the Office of Management and Budget publishes the compiled, amended statute.',
        'Other statutes are also numbered 60, so the note appears only when the text points to this code.',
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
        'La Autoridad de Alianzas Público-Privadas lista a LUMA como operador del sistema de transmisión y distribución eléctrica bajo un contrato de operación y mantenimiento de 15 años, con la AEE (PREPA) y la Autoridad como contrapartes públicas.',
        'La misma página registra los pleitos en curso sobre ese contrato, en palabras del propio gobierno.',
      ],
    },
    en: {
      title: 'LUMA',
      body: [
        'The Public-Private Partnerships Authority lists LUMA as operator of the electric transmission and distribution system under a 15-year operation-and-maintenance contract, with PREPA (the Autoridad de Energía Eléctrica) and the Authority as the public counterparts.',
        'The same page records the pending lawsuits over that contract, in the government’s own words.',
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
        'La AEE —Autoridad de Energía Eléctrica, PREPA en inglés— es la utilidad eléctrica pública de Puerto Rico y la contraparte pública del contrato de transmisión y distribución que opera LUMA, según la Autoridad de Alianzas.',
      ],
    },
    en: {
      title: 'PREPA (AEE)',
      body: [
        'PREPA — the Autoridad de Energía Eléctrica, AEE in Spanish — is Puerto Rico’s public electric utility and the public counterpart on the transmission-and-distribution contract that LUMA operates, per the Partnerships Authority.',
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
        'La Autoridad de Acueductos y Alcantarillados (AAA) es la corporación pública a cargo del servicio de agua y alcantarillado de Puerto Rico.',
        'Las letras AAA también nombran otras cosas —ligas de béisbol, entre ellas—, así que la nota exige el nombre completo o palabras de agua.',
      ],
    },
    en: {
      title: 'Aqueduct and Sewer Authority',
      body: [
        'The Autoridad de Acueductos y Alcantarillados (AAA) is the public corporation in charge of Puerto Rico’s water and sewer service.',
        'The letters AAA also name other things, baseball leagues among them, so the note requires the full name or water-service wording.',
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
        'El Departamento de Hacienda es el tesoro del Gobierno de Puerto Rico; su portal oficial es hacienda.pr.gov.',
        'La palabra “hacienda” sola puede ser una finca o un apellido, así que la nota exige el nombre del departamento.',
      ],
    },
    en: {
      title: 'Puerto Rico Treasury Department',
      body: [
        'The Departamento de Hacienda is the Puerto Rico Treasury Department; its official site is hacienda.pr.gov.',
        'The word “hacienda” alone can be an estate or a surname, so the note requires the department’s name.',
      ],
    },
    sources: [
      { es: 'Departamento de Hacienda', en: 'Puerto Rico Treasury Department', url: 'https://hacienda.pr.gov/' },
    ],
  },
  {
    id: 'ddec',
    priority: 200,
    acronyms: [acronym('DDEC')],
    any: [
      has('departamento de desarrollo economico'),
      has('department of economic development and commerce'),
      has('desarrollo economico y comercio'),
    ],
    weak: [has('desarrollo economico'), has('economic development')],
    context: [has('secretario'), has('secretary'), has('comercio'), has('commerce'), has('departamento'), has('department'), has('ddec')],
    es: {
      title: 'DDEC (Desarrollo Económico y Comercio)',
      body: [
        'El DDEC es el Departamento de Desarrollo Económico y Comercio del Gobierno de Puerto Rico; el directorio oficial del Gobierno dice que lo creó el Plan de Reorganización Núm. 4 de 1994, enmendado por la Ley Núm. 51 de 1994.',
        'Su propia página describe su misión como impulsar el crecimiento económico con política pública, atracción de inversión y desarrollo del ecosistema empresarial.',
      ],
    },
    en: {
      title: 'DDEC (Economic Development and Commerce)',
      body: [
        'DDEC is Puerto Rico’s Department of Economic Development and Commerce; the government’s official directory says it was created by Reorganization Plan No. 4 of 1994, as amended by Act No. 51 of 1994.',
        'Its own page describes its mission as promoting economic growth through public policy, attracting investment, and developing the business ecosystem.',
      ],
    },
    sources: [
      { es: 'PR.gov, directorio de agencias, DDEC', en: 'PR.gov, agency directory, DDEC', url: 'https://pr.gov/directorio-de-agencias/departamento-de-desarrollo-economico-y-comercio-ddec-4' },
      { es: 'DDEC, Oficina del Secretario', en: 'DDEC, Office of the Secretary', url: 'https://www.desarrollo.pr.gov/oficina-del-secretario' },
    ],
  },
  {
    id: 'nfe',
    priority: 210,
    acronyms: [acronym('NFE')],
    any: [has('new fortress'), has('nfenergia'), has('nfe energia')],
    es: {
      title: 'New Fortress Energy (NFE)',
      body: [
        'New Fortress Energy (NFE) es una empresa de energía cotizada en el NASDAQ que, mediante su subsidiaria NFEnergía, vende gas natural a la Autoridad de Energía Eléctrica para sus plantas, según anuncios de la propia empresa.',
        'La Comisión Federal de Energía (FERC) describe la instalación de NFEnergía en el puerto de San Juan —la San Juan Micro-Fuel Handling Facility— como una terminal de importación y regasificación de gas natural licuado que surte gas a la planta de San Juan.',
      ],
    },
    en: {
      title: 'New Fortress Energy (NFE)',
      body: [
        'New Fortress Energy (NFE) is a NASDAQ-listed energy company whose Puerto Rico subsidiary NFEnergía sells natural gas to the Puerto Rico Electric Power Authority for its plants, per the company’s own announcements.',
        'The Federal Energy Regulatory Commission describes NFEnergía’s Port of San Juan facility — the San Juan Micro-Fuel Handling Facility — as an LNG import and regasification facility supplying natural gas to the San Juan Power Plant.',
      ],
    },
    sources: [
      { es: 'New Fortress Energy, contrato con PREPA (anuncio de la empresa)', en: 'New Fortress Energy, contract with PREPA (company release)', url: 'https://ir.newfortressenergy.com/news-releases/news-release-details/new-fortress-energy-signs-contract-supply-natural-gas-san-juan/' },
      { es: 'FERC, proyecto de GNL en San Juan', en: 'FERC, San Juan LNG project', url: 'https://www.ferc.gov/san-juan-lng-project' },
    ],
  },
  {
    id: 'distrito-tmobile',
    priority: 220,
    any: [has('distrito t-?mobile'), has('t-?mobile distrito'), has('t-?mobile district')],
    weak: [word('distrito')],
    context: [has('t-?mobile')],
    es: {
      title: 'Distrito T-Mobile',
      body: [
        'El Distrito T-Mobile es un complejo privado de entretenimiento, gastronomía y hospedería en el Distrito de Convenciones de San Juan, inaugurado oficialmente en agosto de 2021.',
        'Su página aclara que no es propiedad de T-Mobile ni del gobierno: lo desarrolló y construyó la empresa local PRISA Group, con T-Mobile como patrocinador principal.',
      ],
    },
    en: {
      title: 'Distrito T-Mobile',
      body: [
        'Distrito T-Mobile is a private dining, entertainment, and hospitality complex in San Juan’s Convention District that officially opened in August 2021.',
        'Its own page clarifies it is not owned by T-Mobile or the government: it was developed and built by the local company PRISA Group, with T-Mobile as its main sponsor.',
      ],
    },
    sources: [
      { es: 'Distrito T-Mobile, preguntas frecuentes', en: 'Distrito T-Mobile, frequently asked questions', url: 'https://www.distritot-mobile.com/faq' },
    ],
  },
  {
    id: 'coquito',
    priority: 230,
    any: [],
    weak: [word('coquito'), word('coquitos'), has('coquitaz')],
    context: [
      has('navid'), has('christmas'), has('pascu'), has('coco'), has('coconut'),
      word('ron'), word('rum'), has('bebida'), has('drink'), has('tradicion'), has('tradition'),
      has('receta'), has('recipe'), has('tembleque'), has('concurso'), has('festival'),
      has('feria'), has('leche'), has('milk'), has('brindis'), has('botella'),
    ],
    es: {
      title: 'Coquito',
      body: [
        'El coquito es la bebida navideña puertorriqueña de coco y ron, con leche condensada y evaporada; el léxico del español de Puerto Rico que recoge la UPR lo define como “bebida hecha a base de coco y alcohol”.',
        'Su origen no está documentado con exactitud; la BBC recoge que lo más probable es que surgiera hacia los años cincuenta, con la llegada de las leches enlatadas.',
      ],
    },
    en: {
      title: 'Coquito',
      body: [
        'Coquito is Puerto Rico’s Christmas coconut-and-rum drink made with condensed and evaporated milk; the University of Puerto Rico’s record of island Spanish defines it as a coconut-and-alcohol beverage.',
        'Its exact origin is undocumented; the BBC reports it most likely emerged around the 1950s, with the arrival of canned milks.',
      ],
    },
    sources: [
      { es: 'Diálogo UPR, léxico navideño en Puerto Rico', en: 'Diálogo UPR, Puerto Rico Christmas lexicon', url: 'https://dialogo.upr.edu/lexico-navideno-en-puerto-rico/' },
      { es: 'BBC, la bebida navideña favorita de Puerto Rico', en: 'BBC, Coquito: Puerto Rico’s favourite holiday drink', url: 'https://www.bbc.com/travel/article/20241205-coquito-puerto-ricos-favourite-holiday-drink' },
    ],
  },
  {
    id: 'taino',
    priority: 240,
    any: [word('tainos'), has('pueblo taino'), has('indigena tain'), has('taino ind')],
    weak: [word('taino'), word('taina'), word('tainas')],
    context: [
      has('indigen'), has('indian'), has('indios'), word('indio'), has('arqueolog'), has('archaeolog'),
      has('petroglif'), has('cacique'), has('cueva'), has('cave'), has('vasija'), has('yacimiento'),
      has('museo'), has('heritage'), has('historia'), has('history'), has('cultura'), has('culture'),
      has('casabe'), has('areito'), has('canoa'), has('canoe'), has('hamaca'), has('hammock'),
      has('conquist'), has('colonial'), has('prehispan'), has('borinquen'), has('boriken'),
      has('descenden'), has('ancestr'), has('raices'), has('identidad'), has('identity'),
    ],
    es: {
      title: 'Taíno',
      body: [
        '“Taíno” designa a los pueblos de habla arawak de las Antillas Mayores —Puerto Rico entre ellas— y a sus descendientes; la colonización europea tras el encuentro de 1492 devastó su civilización y diezmó su población.',
        'El Instituto Smithsoniano subraya que nunca se extinguieron: registros históricos, tradiciones regionales y un movimiento contemporáneo de descendientes reafirman la identidad indígena taína.',
      ],
    },
    en: {
      title: 'Taíno',
      body: [
        '“Taíno” refers to the Arawak-speaking peoples of the Greater Antilles — Puerto Rico among them — and their descendants; European colonization after the 1492 encounter devastated their civilization and decimated their population.',
        'The Smithsonian stresses they never became extinct: historical records, regional traditions, and a contemporary movement of descendants reaffirm Taíno Indigenous identity.',
      ],
    },
    sources: [
      { es: 'Smithsonian, legado indígena del Caribe (nota de prensa)', en: 'Smithsonian, Indigenous legacy of the Caribbean (news release)', url: 'https://www.si.edu/newsdesk/releases/indigenous-legacy-caribbean-featured-new-smithsonian-exhibition' },
      { es: 'Smithsonian/NMAI, perseverancia taína (nota de prensa)', en: 'Smithsonian/NMAI, Taíno perseverance (news release)', url: 'https://www.si.edu/newsdesk/releases/ta-no-perseverance-subject-upcoming-new-york-city-exhibition-national-museum-american-india' },
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
    'Antecedentes de un glosario revisado; cada entrada enlaza sus fuentes públicas.',
    'Background from a reviewed glossary; each entry links its public sources.',
  );
  const checked = t(
    'Fuentes públicas revisadas el 20 de noviembre de 2026. Esto es contexto, no el reportaje.',
    'Public sources checked on November 20, 2026. This is background, not the reporting.',
  );
  return `<details class="explainer" data-explainer="${escape(shown.map(entry => entry.id).join(','))}"><summary>${escape(t('Contexto', 'Context'))}</summary><div class="explainer-body" lang="${lang}"><p class="explainer-banner">${escape(banner)}</p>${entries}${more}<p class="explainer-checked">${escape(checked)}</p></div></details>`;
}
