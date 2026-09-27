import { DataFactory } from 'rdf-data-factory';
import { Config } from "../../ontologies/SparnaturalConfig";
import { ISparnaturalSpecification } from "../ISparnaturalSpecification";
import { Parser } from "@traqula/parser-sparql-1-1";
import { AstFactory, AstTransformer, ContextDefinition, Query, TermIri } from "@traqula/rules-sparql-1-1";
import { SparqlGeneratorV13 } from "../../generators/sparql/fromjsonv13/SparqlGeneratorV13";
import { ISpecificationEntity } from "../ISpecificationEntity";
import { OWLSpecificationEntity } from "./OWLSpecificationEntity";
import ISpecificationProperty from "../ISpecificationProperty";
import { OWLSpecificationProperty } from "./OWLSpecificationProperty";
import { RdfStore } from "rdf-stores";
import { NamedNode, Quad_Subject, Term } from '@rdfjs/types/data-model';
import { Dag, DagIfc } from '../../dag/Dag';
import { BaseRdfStore } from '../BaseRdfStore';
import { RDFS } from 'rdf-shacl-commons';

const factory = new DataFactory();
const F = new AstFactory();

const OWL_NAMESPACE = "http://www.w3.org/2002/07/owl#";
export const OWL = {
  THING: factory.namedNode(OWL_NAMESPACE + "Thing") as NamedNode,
  EQUIVALENT_PROPERTY: factory.namedNode(OWL_NAMESPACE + "equivalentProperty") as NamedNode,
  EQUIVALENT_CLASS: factory.namedNode(OWL_NAMESPACE + "equivalentClass") as NamedNode,
  UNION_OF: factory.namedNode(OWL_NAMESPACE + "unionOf") as NamedNode
};

export class OWLSpecificationProvider extends BaseRdfStore implements ISparnaturalSpecification {
  #parser: Parser;
  #generator: SparqlGeneratorV13;

  constructor(n3store: RdfStore, lang: string) {
    super(n3store, lang);

    // init SPARQL parser and generator once
    // keep track of the position of each node in the query, so that the generator can output the parts
    // of the query that were not modified exactly as they were (including comments)
    this.#parser = new Parser({
      defaultContext: { astFactory: F },
      lexerConfig: { positionTracking: "full" },
    });
    this.#generator = new SparqlGeneratorV13();

    /*
    var sparql = `
    SELECT ?o2 WHERE {
        {
          OPTIONAL {?x ?p1 ?var_1 }
          OPTIONAL {?x ?p2 ?var_2 }
          BIND(COALESCE(?var_1, ?var_2) AS ?var)
        }
        ?x ?p2 ?o2 .
    }
    `;

    var query = this.#parser.parse(sparql);
    console.dir(query)
    */

  }


  getLanguages(): string[] {
    let languages:string[] = this.store
      .getQuads(null, RDFS.LABEL, null, null)
      .map((quad: { object: any }) => quad.object.language);
    // deduplicate the list of languages
    return [...new Set(languages)];
  }

  getEntity(entityUri: string): ISpecificationEntity {
    return new OWLSpecificationEntity(
      entityUri,
      this,
      this.store,
      this.lang
    );
  }

  getProperty(property: string): ISpecificationProperty {
    return new OWLSpecificationProperty(
      property,
      this,
      this.store,
      this.lang
    );
  }  

  getAllSparnaturalEntities() {
    var classes = this.getEntitiesInDomainOfAnyProperty();

    // copy initial array
    // create a set to avoid duplicates
    var result = new Set<string>(classes.slice());

    // now look for all classes we can reach from this class list
    for (const aClass of classes) {
      var connectedClasses = this.getEntity(aClass).getConnectedEntities();
      for (const aConnectedClass of connectedClasses) {
        result.add(aConnectedClass);
      }
    }
    return Array.from(result);
  }

  getEntitiesInDomainOfAnyProperty() : string[] {
    const quadsArray = this.store.getQuads(
      null,
      RDFS.DOMAIN,
      null,
      null
    );

    const items = new Set<string>();

    for (const quad of quadsArray) {
      // we are not looking at domains of _any_ property
      // the property we are looking at must be a Sparnatural property, with a known type
      var objectPropertyId = quad.subject.value;
      var typeClass = quad.object.termType;
      var classId = quad.object.value;
      var classAsRDFTerm = quad.object;

      // empty string means we are searching without specifying a range
      if (this.getProperty(objectPropertyId).getPropertyType("")) {
        // keep only Sparnatural classes in the list
        if (typeClass == "BlankNode" || this.isSparnaturalClass(classId)) {
          // always exclude "remote classes" that should not have a type that from first list
          if (this.getEntity(classId).hasTypeCriteria()) {
            if (!this._isUnionClass(classAsRDFTerm)) {
              items.add(classId);
            } else {
              // read union content - /!\ this returns RDFTerm
              var classesInUnion = this.graph.readAsList(classAsRDFTerm, OWL.UNION_OF);
              for (const aUnionClass of classesInUnion) {
                items.add(aUnionClass.value);
              }
            }
          }
        }
      }
    }

    return this._sort(Array.from(items));
  }


  getEntitiesTreeInDomainOfAnyProperty(): DagIfc<ISpecificationEntity> {
    // 1. get the entities that are in a domain of a property
    let entities:OWLSpecificationEntity[] = this.getEntitiesInDomainOfAnyProperty().map(s => this.getEntity(s) as OWLSpecificationEntity) as OWLSpecificationEntity[];

    // build dag from flat list
    let dag:Dag<OWLSpecificationEntity> = new Dag<OWLSpecificationEntity>();
    dag.initFlatTreeFromFlatList(entities);

    return dag;
  }


  isSparnaturalClass(classUri: string) {
    return (
      this.store.getQuads(
        factory.namedNode(classUri),
        RDFS.SUBCLASS_OF,
        factory.namedNode(Config.SPARNATURAL_CLASS),
        null
      ).length > 0 ||
      this.store.getQuads(
        factory.namedNode(classUri),
        RDFS.SUBCLASS_OF,
        factory.namedNode(Config.NOT_INSTANTIATED_CLASS),
        null
      ).length > 0 ||
      this.store.getQuads(
        factory.namedNode(classUri),
        RDFS.SUBCLASS_OF,
        factory.namedNode(Config.RDFS_LITERAL),
        null
      ).length > 0
    );
  }

  expandSparql(sparql: string, prefixes:{ [key: string]: string }) {
    // for each owl:equivalentProperty ...
    var equivalentPropertiesPerProperty: any = {};
    this.store
      .getQuads(null, OWL.EQUIVALENT_PROPERTY, null, null)
      .forEach(
        (quad: { subject: { value: string | number }; object: { value: any } }) => {
          // store it if multiple equivalences are declared
          if (!equivalentPropertiesPerProperty[quad.subject.value]) {
            equivalentPropertiesPerProperty[quad.subject.value] = [];
          }
          equivalentPropertiesPerProperty[quad.subject.value].push(quad.object.value);
        }
      );
    // join the equivalences with a |
    for (let [property, equivalents] of Object.entries(
      equivalentPropertiesPerProperty
    )) {
      var re = new RegExp("<" + property + ">", "g");
      sparql = sparql.replace(
        re,
        "<" + (equivalents as Array<any>).join(">|<") + ">"
      );
    }

    // for each owl:equivalentClass ...
    var equivalentClassesPerClass: any = {};
    this.store
      .getQuads(null, OWL.EQUIVALENT_CLASS, null, null)
      .forEach(
        (quad: { subject: { value: string | number }; object: { value: any } }) => {
          // store it if multiple equivalences are declared
          if (!equivalentClassesPerClass[quad.subject.value]) {
            equivalentClassesPerClass[quad.subject.value] = [];
          }
          equivalentClassesPerClass[quad.subject.value].push(quad.object.value);
        }
      );
    // use a VALUES if needed
    var i = 0;
    for (let [aClass, equivalents] of Object.entries(
      equivalentClassesPerClass
    )) {
      var re = new RegExp("<" + aClass + ">", "g");
      if ((equivalents as Array<any>).length == 1) {
        sparql = sparql.replace(re, "<" + (equivalents as Array<any>)[0] + ">");
      } else {
        sparql = sparql.replace(
          re,
          "?class" +
            i +
            " . VALUES ?class" +
            i +
            " { <" +
            (equivalents as Array<any>).join("> <") +
            "> } "
        );
      }
      i++;
    }

    // for each sparqlString
    this.store
      .getQuads(null, factory.namedNode(Config.SPARQL_STRING), null, null)
      .forEach((quad: { subject: { value: string }; object: { value: any } }) => {
        // prepare the regex
        let classUri = quad.subject.value;
        let sparqlString = quad.object.value;

        // first pass to work with classes sparqlString that can contain a long expression
        // with variables and MINUSes, like
        // <http://exemple.com/MyClass> MINUS { $this <http://exemple.com/myProp> ?x VALUES ?x { A B } }

        // replace the $this with the name of the original variable in the query
        // \S matches any non-whitespace character
        var re = new RegExp("(\\S*) (rdf:type|a) <" + classUri + ">", "g");  

        // prepare the function that will return the string to replace
        let replacer = function(match:string, p1:string, offset:number, fullString:string) {
            // first substitutes any other variable name with a prefix
            // so that we garantee unicity across the complete query
            var reVariables = new RegExp("\\?(\\S*)", "g");
            let whereClauseReplacedVariables = p1+" rdf:type "+sparqlString.replace(reVariables, "?$1_"+p1.substring(1));
            
            // then, replace the match on the original URI with the whereClause of the target
            // replacing "$this" with the original variable name
            var reThis = new RegExp("\\$this", "g");
            let whereClauseReplacedThis = whereClauseReplacedVariables.replace(reThis, p1);
            return whereClauseReplacedThis;
          }

        sparql = sparql.replace(re, replacer);

        // then a second pass simpler one that will work for properties
        var re = new RegExp("<" + quad.subject.value + ">", "g");
        sparql = sparql.replace(re, quad.object.value);
      });


    // reparse the query, apply prefixes, and reserialize the query
    var query = <Query> this.#parser.parse(sparql);
    let finalString = this.#generator.generate(this.#applyPrefixes(query, prefixes), { origSource: sparql });
    return finalString
  }

  /**
   * Uses prefixed names in the query wherever possible, like SparqlJs does when serializing a query.
   * Only the modified nodes are marked to be generated again, the rest of the query is kept as it was.
   * @param query The parsed query
   * @param prefixes The prefixes to use, in addition to the ones declared in the query (and overriding them)
   * @returns the query, with prefixed names, declaring only the prefixes it uses
   */
  #applyPrefixes(query: Query, prefixes: { [key: string]: string }): Query {
    // the prefixes declared in the query
    let queryPrefixes: { [key: string]: string } = {};
    query.context.forEach((c) => {
      if (c.subType === "prefix") queryPrefixes[c.key] = c.value.value;
    });
    let allPrefixes: { [key: string]: string } = { ...queryPrefixes, ...prefixes };

    // if multiple prefixes share the same namespace, the last one is used
    let prefixByNamespace = new Map<string, string>();
    Object.entries(allPrefixes).forEach(([prefix, namespace]) => prefixByNamespace.set(namespace, prefix));

    let usedPrefixes = new Set<string>();
    let compactedQuery = new AstTransformer().transformNodeSpecific<"unsafe", Query>(query, {}, {
      term: {
        namedNode: {
          transform: (iri: TermIri) => {
            // expand the prefixed names of the query
            let fullIri = F.isTermNamedPrefixed(iri) ? queryPrefixes[iri.prefix] + iri.value : iri.value;
            let prefix: string | undefined;
            let localName: string | undefined;
            for (let namespace of Object.values(allPrefixes)) {
              // same local names as the ones SparqlJs turns into prefixed names
              if (fullIri.startsWith(namespace) && /^[a-zA-Z][\-_a-zA-Z0-9]*$/.test(fullIri.substring(namespace.length))) {
                prefix = prefixByNamespace.get(namespace);
                localName = fullIri.substring(namespace.length);
                usedPrefixes.add(prefix);
                break;
              }
            }

            let originalPrefix = F.isTermNamedPrefixed(iri) ? iri.prefix : undefined;
            if (prefix === originalPrefix && (prefix ? localName : fullIri) === iri.value) {
              // unchanged
              return iri;
            }
            return prefix
              ? F.termNamed(F.sourceLocationNodeReplaceUnsafe(iri.loc), localName, prefix)
              : F.termNamed(F.sourceLocationNodeReplaceUnsafe(iri.loc), fullIri);
          },
        },
      },
    });

    // declare only the prefixes used in the query
    let context: ContextDefinition[] = compactedQuery.context.map((c) => {
      if (c.subType !== "prefix" || (usedPrefixes.has(c.key) && allPrefixes[c.key] === c.value.value)) {
        return c;
      }
      if (usedPrefixes.has(c.key)) {
        // the namespace of the prefix was overridden
        return F.contextDefinitionPrefix(F.sourceLocationNodeReplaceUnsafe(c.loc), c.key, F.termNamed(F.gen(), allPrefixes[c.key]));
      }
      // an unused prefix is removed from the query string
      return F.isSourceLocationSource(c.loc) ? { ...c, loc: F.sourceLocationStringReplace("", c.loc.start, c.loc.end) } : null;
    }).filter((c) => c !== null);
    Object.entries(prefixes)
      .filter(([prefix]) => usedPrefixes.has(prefix) && !(prefix in queryPrefixes))
      .forEach(([prefix, namespace]) => context.push(F.contextDefinitionPrefix(F.gen(), prefix, F.termNamed(F.gen(), namespace))));
    compactedQuery.context = context;
    return compactedQuery;
  }

  _sort(items: any[]) {
    var me = this;
    const compareFunction = function (item1: any, item2: any) {
      // return me.getLabel(item1).localeCompare(me.getLabel(item2));

      var entity1 = me.getEntity(item1);
      var entity2 = me.getEntity(item2);

      var order1 = entity1.getOrder();
      var order2 = entity2.getOrder();

      if (order1) {
        if (order2) {
          if (order1 == order2) {
            return entity1.getLabel().localeCompare(entity2.getLabel());
          } else {
            // if the order is actually a number, convert it to number and use a number conversion
            if(!isNaN(Number(order1)) && !isNaN(Number(order2))) {
              return Number(order1) - Number(order2);
            } else {
              return (order1 > order2) ? 1 : -1;
            }
          }
        } else {
          return -1;
        }
      } else {
        if (order2) {
          return 1;
        } else {
          return entity1.getLabel().localeCompare(entity2.getLabel());
        }
      }
    };

    // sort according to order or label
    items.sort(compareFunction);
    return items;
  }

  /**
   * Reads config:order of an entity and returns it, or null if not set
   **/
  _readOrder(uri: any) {
    return this.graph.readSingleProperty(uri, factory.namedNode(Config.ORDER))?.value;
  }



  /*** Handling of UNION classes ***/

  _readUnionContent(classUri: any) {
    var lists = this.graph.readProperty(factory.namedNode(classUri), OWL.UNION_OF);
    if (lists.length > 0) {
      return this.graph.readListContent(lists[0]);
    }
  }

  _isUnionClass(classUriOrBNodeIdentifier: Term) {
    return this.graph.hasProperty(classUriOrBNodeIdentifier as Quad_Subject, OWL.UNION_OF);
  }

  /*** / Handling of UNION classes ***/


}
