import { SparnaturalSpecificationFactory } from '../../sparnatural/spec-providers/SparnaturalSpecificationFactory';
import { OWLSpecificationProvider } from '../../sparnatural/spec-providers/owl/OWLSpecificationProvider';

const CONFIG = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix core: <http://data.sparna.fr/ontologies/sparnatural-config-core#> .
@prefix ex: <http://example.com/> .

ex:Person a owl:Class ; owl:equivalentClass ex:Human .
ex:Document a owl:Class ; owl:equivalentClass ex:Book, ex:Article .
ex:knows a owl:ObjectProperty ; owl:equivalentProperty ex:acquaintedWith .
ex:name a owl:DatatypeProperty ; owl:equivalentProperty ex:fullName, rdfs:label .
ex:author a owl:ObjectProperty ; core:sparqlString "^<http://example.com/wrote>" .
`;

const QUERY = `SELECT DISTINCT ?Person_1 ?Document_1 ?Person_1_label WHERE {
  ?Person_1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.com/Person> .
  ?Person_1 <http://example.com/knows> ?Person_2 .
  ?Person_2 <http://example.com/author> ?Document_1 .
  ?Document_1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.com/Document> .
  ?Person_1 <http://example.com/name> ?Person_1_label .
  VALUES ?Person_2 { <http://example.com/person-1_a> <http://example.com/1person> }
}`;

async function buildSpecProviderFromConfig(configTtl: string, language = 'en') {
  const factory = new SparnaturalSpecificationFactory();
  return await new Promise<any>((resolve, reject) => {
    try {
      factory.build(configTtl, language, undefined, (provider: any) => resolve(provider));
    } catch (e) {
      reject(e);
    }
  });
}

describe('OWLSpecificationProvider.expandSparql', () => {
  let specProvider: OWLSpecificationProvider;

  beforeAll(async () => {
    specProvider = await buildSpecProviderFromConfig(CONFIG);
    expect(specProvider).toBeInstanceOf(OWLSpecificationProvider);
  });

  it('expands equivalent classes and properties, and sparqlString', () => {
    expect(specProvider.expandSparql(QUERY, {})).toBe(`SELECT DISTINCT ?Person_1 ?Document_1 ?Person_1_label WHERE {
  ?Person_1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.com/Human> .
  ?Person_1 <http://example.com/acquaintedWith> ?Person_2 .
  ?Person_2 ^<http://example.com/wrote> ?Document_1 .
  ?Document_1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?class1 . VALUES ?class1 { <http://example.com/Book> <http://example.com/Article> }  .
  ?Person_1 <http://example.com/fullName>|<http://www.w3.org/2000/01/rdf-schema#label> ?Person_1_label .
  VALUES ?Person_2 { <http://example.com/person-1_a> <http://example.com/1person> }
}`);
  });

  it('uses prefixed names wherever possible, and declares only the prefixes it uses', () => {
    const prefixes = {
      ex: 'http://example.com/',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      skos: 'http://www.w3.org/2004/02/skos/core#',
    };
    // "1person" can't be turned into a prefixed name
    expect(specProvider.expandSparql(QUERY, prefixes)).toBe(`PREFIX ex: <http://example.com/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?Person_1 ?Document_1 ?Person_1_label WHERE {
  ?Person_1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ex:Human .
  ?Person_1 ex:acquaintedWith ?Person_2 .
  ?Person_2 ^ex:wrote ?Document_1 .
  ?Document_1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?class1 . VALUES ?class1 { ex:Book ex:Article }  .
  ?Person_1 ex:fullName|rdfs:label ?Person_1_label .
  VALUES ?Person_2 { ex:person-1_a <http://example.com/1person> }
}`);
  });

  it('overrides the prefixes declared in the query with the given prefixes', () => {
    const query = `PREFIX ex: <http://example.com/>
PREFIX foo: <http://foo.org/>
SELECT ?x WHERE { ?x a ex:Person . }`;
    const prefixes = {
      ex: 'http://other.org/',
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    };
    // the declarations of the unused prefixes are removed
    expect(specProvider.expandSparql(query, prefixes)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?x WHERE { ?x rdf:type <http://example.com/Person> . }`);
  });

  it('keeps the comments of the query', () => {
    const query = `SELECT ?x WHERE {
  # the persons
  ?x <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.com/Person> .
  # who know someone
  ?x <http://example.com/knows> ?y .
}`;
    expect(specProvider.expandSparql(query, { ex: 'http://example.com/' })).toBe(`PREFIX ex: <http://example.com/>
SELECT ?x WHERE {
  # the persons
  ?x <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ex:Human .
  # who know someone
  ?x ex:acquaintedWith ?y .
}`);
  });
});
