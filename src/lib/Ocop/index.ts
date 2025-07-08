import GraphQLUpload from "graphql-upload/GraphQLUpload.mjs";
import { envConf } from "../../constants";
import { ApolloServer } from "@apollo/server";
import gql from "graphql-tag";
import flattenDeep from "lodash.flattendeep";
import memoize from "micro-memoize";
import createCorsMiddleware from "cors";
import { execute, print } from "graphql";
import pinoLogger from "pino-http";
import { buildSubgraphSchema } from "@apollo/subgraph";
import {
  arrayToObject,
  objMerge,
  flatten,
  unique,
  filterValues,
  upcase,
  falsey,
} from "@ocopjs/utils";
import {
  validateFieldAccessControl,
  validateListAccessControl,
  validateCustomAccessControl,
  validateAuthAccessControl,
} from "@ocopjs/access-control";
// import { createJWTMiddlewareV2 } from "@ocopjs/session";
import { AppVersionProvider, appVersionMiddleware } from "@ocopjs/app-version";
import { List } from "../ListTypes";
import {
  CustomProvider,
  ListAuthProvider,
  ListCRUDProvider,
} from "../providers";
import { formatError } from "./format-error";

const composePlugins = (fns) => (o, e) =>
  fns.reduce((acc, fn) => fn(acc, e), o);

export { List };

export class Ocop {
  server;
  adapter;
  lists = {};
  listsArray = [];
  _schemas = {};
  listCRUDProvider;
  registeredTypes = new Set();
  jwt; // jwt secret

  constructor({
    onInit = () => {},
    defaultAccess,
    jwt,
    adapter,
    onConnect,
    queryLimits = {},
    schemaNames = ["public"],
    appVersion,
    appName = "ocop",
  }) {
    this.onInit = onInit;
    this.defaultAccess = Object.assign(
      {
        list: true,
        field: true,
        custom: true,
      },
      defaultAccess,
    );
    this.auth = {};
    this.eventHandlers = { onConnect };
    this._schemaNames = schemaNames;
    this.appVersion = Object.assign(
      {
        version: "1.0.0",
        addVersionToHttpHeaders: true,
        access: true,
      },
      appVersion,
    );

    this.listCRUDProvider = new ListCRUDProvider({ metaPrefix: appName });

    this.customProvider = new CustomProvider({
      schemaNames,
      defaultAccess: this.defaultAccess,
    });

    this.appVersionProvider = new AppVersionProvider({
      version: this.appVersion.version,
      access: this.appVersion.access,
      schemaNames,
      appName,
    });

    this.queryLimits = Object.assign(
      {
        maxTotalResults: Infinity,
      },
      queryLimits,
    );

    if (this.queryLimits.maxTotalResults < 1) {
      throw new Error("queryLimits.maxTotalResults can't be < 1");
    }

    this.adapter = adapter;
    this.jwt = jwt;
    // if (!this.jwt) {
    //   throw new Error("JWT secret is required");
    // }

    this.getListByKey = (key) => this.lists[key];
  }
  getProviders() {
    return [
      this.listCRUDProvider,
      this.customProvider,
      this.appVersionProvider,
      this.listAuthProvider,
    ].filter((provider) => !!provider);
  }

  _getAccessControlContext({ schemaName, authentication, skipAccessControl }) {
    if (skipAccessControl) {
      return {
        getCustomAccessControlForUser: () => true,
        getListAccessControlForUser: () => true,
        getFieldAccessControlForUser: () => true,
        getAuthAccessControlForUser: () => true,
      };
    }
    // memoizing to avoid requests that hit the same type multiple times.
    // We do it within the request callback so we can resolve it based on the
    // request info (like who's logged in right now, etc)
    const getCustomAccessControlForUser = memoize(
      async (item, args, context, info, access, gqlName) => {
        return validateCustomAccessControl({
          item,
          args,
          context,
          info,
          access: access[schemaName],
          authentication,
          gqlName,
        });
      },
      { isPromise: true },
    );

    const getListAccessControlForUser = memoize(
      async (
        access,
        listKey,
        originalInput,
        operation,
        { gqlName, itemId, itemIds, context } = {},
      ) => {
        return validateListAccessControl({
          access: access[schemaName],
          originalInput,
          operation,
          authentication,
          listKey,
          gqlName,
          itemId,
          itemIds,
          context,
        });
      },
      { isPromise: true },
    );

    const getFieldAccessControlForUser = memoize(
      async (
        access,
        listKey,
        fieldKey,
        originalInput,
        existingItem,
        operation,
        { gqlName, itemId, itemIds, context } = {},
      ) => {
        return validateFieldAccessControl({
          access: access[schemaName],
          originalInput,
          existingItem,
          operation,
          authentication,
          fieldKey,
          listKey,
          gqlName,
          itemId,
          itemIds,
          context,
        });
      },
      { isPromise: true },
    );

    const getAuthAccessControlForUser = memoize(
      async (access, listKey, { gqlName, context } = {}) => {
        return validateAuthAccessControl({
          access: access[schemaName],
          authentication,
          listKey,
          gqlName,
          context,
        });
      },
      { isPromise: true },
    );

    return {
      getCustomAccessControlForUser,
      getListAccessControlForUser,
      getFieldAccessControlForUser,
      getAuthAccessControlForUser,
    };
  }

  createContext({
    schemaName = "public",
    authentication = {},
    skipAccessControl = false,
  } = {}) {
    const context = {
      schemaName,
      authedItem: authentication.item,
      authedListKey: authentication.listKey,
      ...this._getAccessControlContext({
        schemaName,
        authentication,
        skipAccessControl,
      }),
      totalResults: 0,
      maxTotalResults: this.queryLimits.maxTotalResults,
    };
    // Locally bind the values we use as defaults into an object to make
    // JS behave the way we want.
    const defaults = { schemaName, authentication, skipAccessControl, context };
    context.createContext = ({
      schemaName = defaults.schemaName,
      authentication = defaults.authentication,
      skipAccessControl = defaults.skipAccessControl,
    } = {}) =>
      this.createContext({ schemaName, authentication, skipAccessControl });
    context.sudo = () =>
      this.createContext({
        schemaName,
        authentication,
        skipAccessControl: true,
      });

    context.excuteExtendGQL = ({
      context = defaults.context,
      query,
      variables,
    }) => {
      console.log("excuteExtendGQL", query);
    };

    context.executeGraphQL = ({
      context = defaults.context,
      query,
      variables,
    }) => this.executeGraphQL({ context, query, variables });
    context.gqlNames = (listKey) => this.lists[listKey].gqlNames;
    return context;
  }

  executeGraphQL({ context, query, variables }) {
    if (!context) {
      context = this.createContext({});
    }

    const schema = this._schemas[context.schemaName];
    if (!schema) {
      throw new Error(
        `No executable schema named '${context.schemaName}' is available. Have you setup '@ocopjs/app-graphql'?`,
      );
    }

    if (typeof query === "string") {
      query = gql(query);
    }

    return execute(schema, query, null, context, variables);
  }

  createAuthStrategy(options) {
    const {
      type: StrategyType,
      list: listKey,
      config,
      hooks,
    } = composePlugins(options.plugins || [])(options, { ocop: this });

    const { authType } = StrategyType;
    if (!this.auth[listKey]) {
      this.auth[listKey] = {};
    }
    const strategy = new StrategyType(this, listKey, config);

    strategy.authType = authType;

    this._sessionManager = strategy.sessionManager;
    this.auth[listKey][authType] = strategy;
    if (!this.getListByKey(listKey)) {
      strategy.gqlNames = {
        outputTypeName: listKey,
        authenticatedQueryName: `authenticated${listKey}`,
        authenticateMutationName: `authenticate${listKey}With${upcase(
          strategy.authType,
        )}`,
        unauthenticateMutationName: `unauthenticate${listKey}`,
        authenticateOutputName: `authenticate${listKey}Output`,
        unauthenticateOutputName: `unauthenticate${listKey}Output`,
        updateAuthenticatedMutationName: `updateAuthenticated${listKey}`,
      };
    } else {
      this.listAuthProvider = new ListAuthProvider({
        list: this.getListByKey(listKey),
        authStrategy: strategy,
        hooks,
      });
    }
    return strategy;
  }

  createList(key, config, { isAuxList = false } = {}) {
    const { getListByKey, adapter } = this;
    const isReservedName = !isAuxList && key[0] === "_";

    if (isReservedName) {
      throw new Error(
        `Invalid list name "${key}". List names cannot start with an underscore.`,
      );
    }
    if (["Query", "Subscription", "Mutation"].includes(key)) {
      throw new Error(
        `Invalid list name "${key}". List names cannot be reserved GraphQL keywords.`,
      );
    }

    // Ocop automatically adds an 'Upload' scalar type to the GQL schema. Since list output
    // types are named after their keys, having a list name 'Upload' will clash and cause a confusing
    // error on start.
    if (key === "Upload" || key === "upload") {
      throw new Error(
        `Invalid list name "Upload": Built-in GraphQL types cannot be used as a list name.`,
      );
    }

    const list = new List(
      key,
      /**/
      composePlugins(config.plugins || [])(config, {
        listKey: key,
        ocop: this,
      }),
      /**/
      {
        getListByKey,
        adapter,
        defaultAccess: this.defaultAccess,
        registerType: (type) => this.registeredTypes.add(type),
        isAuxList,
        createAuxList: (auxKey, auxConfig) => {
          if (isAuxList) {
            throw new Error(
              `Aux list "${key}" shouldn't be creating more aux lists ("${auxKey}"). Something's probably not right here.`,
            );
          }
          return this.createList(auxKey, auxConfig, { isAuxList: true });
        },
        schemaNames: this._schemaNames,
      },
    );
    this.lists[key] = list;
    this.listsArray.push(list);
    this.listCRUDProvider.lists.push(list);
    list.initFields();
    return list;
  }

  extendGraphQLSchema({
    types = [],
    queries = [],
    mutations = [],
    subscriptions = [],
  }) {
    return this.customProvider.extendGraphQLSchema({
      types,
      queries,
      mutations,
      subscriptions,
    });
  }

  _consolidateRelationships() {
    const rels = {};
    const otherSides = {};
    this.listsArray.forEach((list) => {
      list.fields
        .filter((f) => f.isRelationship)
        .forEach((f) => {
          const myRef = `${f.listKey}.${f.path}`;
          if (otherSides[myRef]) {
            // I'm already there, go and update rels[otherSides[myRef]] with my info
            rels[otherSides[myRef]].right = f;

            // Make sure I'm actually referencing the thing on the left
            const { left } = rels[otherSides[myRef]];
            if (f.config.ref !== `${left.listKey}.${left.path}`) {
              throw new Error(
                `${myRef} refers to ${f.config.ref}. Expected ${left.listKey}.${left.path}`,
              );
            }
          } else {
            // Got us a new relationship!
            rels[myRef] = { left: f };
            if (f.refFieldPath) {
              // Populate otherSides
              otherSides[f.config.ref] = myRef;
            }
          }
        });
    });
    // See if anything failed to link up.
    const badRel = Object.values(rels).find(
      ({ left, right }) => left.refFieldPath && !right,
    );
    if (badRel) {
      const { left } = badRel;
      throw new Error(
        `${left.listKey}.${left.path} refers to a non-existant field, ${left.config.ref}`,
      );
    }

    // Ensure that the left/right pattern is always the same no matter what order
    // the lists and fields are defined.
    Object.values(rels).forEach((rel) => {
      const { left, right } = rel;
      if (right) {
        const order = left.listKey.localeCompare(right.listKey);
        if (order > 0) {
          // left comes after right, so swap them.
          rel.left = right;
          rel.right = left;
        } else if (order === 0) {
          // self referential list, so check the paths.
          if (left.path.localeCompare(right.path) > 0) {
            rel.left = right;
            rel.right = left;
          }
        }
      }
    });

    Object.values(rels).forEach((rel) => {
      const { left, right } = rel;
      let cardinality;
      if (left.config.many) {
        if (right) {
          if (right.config.many) {
            cardinality = "N:N";
          } else {
            cardinality = "1:N";
          }
        } else {
          // right not specified, have to assume that it's N:N
          cardinality = "N:N";
        }
      } else {
        if (right) {
          if (right.config.many) {
            cardinality = "N:1";
          } else {
            cardinality = "1:1";
          }
        } else {
          // right not specified, have to assume that it's N:1
          cardinality = "N:1";
        }
      }
      rel.cardinality = cardinality;

      let tableName;
      let columnName;
      if (cardinality === "N:N") {
        tableName = right
          ? `${left.listKey}_${left.path}_${right.listKey}_${right.path}`
          : `${left.listKey}_${left.path}_many`;
        if (right) {
          const leftKey = `${left.listKey}.${left.path}`;
          const rightKey = `${right.listKey}.${right.path}`;
          rel.columnNames = {
            [leftKey]: {
              near: `${left.listKey}_left_id`,
              far: `${right.listKey}_right_id`,
            },
            [rightKey]: {
              near: `${right.listKey}_right_id`,
              far: `${left.listKey}_left_id`,
            },
          };
        } else {
          const leftKey = `${left.listKey}.${left.path}`;
          const rightKey = `${left.config.ref}`;
          rel.columnNames = {
            [leftKey]: {
              near: `${left.listKey}_left_id`,
              far: `${left.config.ref}_right_id`,
            },
            [rightKey]: {
              near: `${left.config.ref}_right_id`,
              far: `${left.listKey}_left_id`,
            },
          };
        }
      } else if (cardinality === "1:1") {
        tableName = left.listKey;
        columnName = left.path;
      } else if (cardinality === "1:N") {
        tableName = right.listKey;
        columnName = right.path;
      } else {
        tableName = left.listKey;
        columnName = left.path;
      }
      rel.tableName = tableName;
      rel.columnName = columnName;
    });
    return Object.values(rels);
  }

  /**
   * Connects to the database via the given adapter(s)
   *
   * @return Promise<any> the result of executing `onConnect` as passed to the
   * constructor, or `undefined` if no `onConnect` method specified.
   */
  async connect(args) {
    if (this.adapter) {
      await this.adapter.connect({ rels: this._consolidateRelationships() });
    }

    if (this.eventHandlers.onConnect) {
      return this.eventHandlers.onConnect(this, args);
    }
  }

  createApolloServer({ apolloConfig = {}, schemaName, dev, logger }) {
    if (logger) logger("Tạo máy chủ Apollo");
    if (this.server) return this.server;
    const context = ({ req }) => {
      const accessContext = this.createContext({
        schemaName,
        authentication: { item: req.user, listKey: req.authedListKey },
        skipAccessControl: false,
      });

      const sessionContext = this._sessionManager?.getContext(req);

      return {
        ...accessContext,
        ...sessionContext,
        req,
      };
    };
    const typeDefs = this.getTypeDefs({ schemaName });
    const resolvers = this.getResolvers({ schemaName });
    const server = new ApolloServer({
      typeDefs,
      resolvers,
      context,
      engine: false,
      csrfPrevention: false,
      tracing: dev,
      formatError,
      schemaName: "internal",
      schema: buildSubgraphSchema({ typeDefs, resolvers }),
      uploads: false, // User cannot override this as it would clash with the upload middleware
      ...apolloConfig,
    });
    this._schemas[schemaName] = server.schema;
    this.server = server;
    server._context = context;
    return server;
  }

  /**
   * @return Promise<null>
   */
  async disconnect() {
    if (this.adapter) await this.adapter.disconnect();
  }

  getAdminMeta({ schemaName }) {
    // We've consciously made a design choice that the `read` permission on a
    // list is a master switch in the Admin UI (not the GraphQL API).
    // Justification: If you want to Create without the Read permission, you
    // technically don't have permission to read the result of your creation.
    // If you want to Update an item, you can't see what the current values
    // are. If you want to delete an item, you'd need to be given direct
    // access to it (direct URI), but can't see anything about that item. And
    // in fact, being able to load a page with a 'delete' button on it
    // violates the read permission as it leaks the fact that item exists.
    // In all these cases, the Admin UI becomes unnecessarily complex.
    // So we only allow all these actions if you also have read access.
    const lists = arrayToObject(
      this.listsArray.filter(
        (list) => list.access[schemaName].read && !list.isAuxList,
      ),
      "key",
      (list) => list.getAdminMeta({ schemaName }),
    );

    return { lists };
  }

  getAdminViews({ schemaName }) {
    return {
      listViews: arrayToObject(
        this.listsArray.filter(
          (list) => list.access[schemaName].read && !list.isAuxList,
        ),
        "key",
        (list) => list.views,
      ),
    };
  }

  getTypeDefs({ schemaName }) {
    const queries = unique(
      flatten(this.getProviders().map((p) => p.getQueries({ schemaName }))),
    );
    const mutations = unique(
      flatten(this.getProviders().map((p) => p.getMutations({ schemaName }))),
    );
    const subscriptions = unique(
      flatten(
        this.getProviders().map((p) => p.getSubscriptions({ schemaName })),
      ),
    );

    // Fields can be represented multiple times within and between lists.
    // If a field defines a `getGqlAuxTypes()` method, it will be
    // duplicated.
    // graphql-tools will blow up (rightly so) on duplicated types.
    // Deduping here avoids that problem.
    return [
      ...unique(
        flatten(this.getProviders().map((p) => p.getTypes({ schemaName }))),
      ),
      queries.length > 0 && `type Query { ${queries.join("\n")} }`,
      mutations.length > 0 && `type Mutation { ${mutations.join("\n")} }`,
      subscriptions.length > 0 &&
        `type Subscription { ${subscriptions.join("\n")} }`,
      "scalar Upload",
    ]
      .filter((s) => s)
      .map((s) => gql(s));
  }

  getResolvers({ schemaName }) {
    // Like the `typeDefs`, we want to dedupe the resolvers. We rely on the
    // semantics of the JS spread operator here (duplicate keys are overridden
    // - last one wins)
    // TODO: Document this order of precedence, because it's not obvious, and
    // there's no errors thrown
    // TODO: console.warn when duplicate keys are detected?
    return filterValues(
      {
        // Order of spreading is important here - we don't want user-defined types
        // to accidentally override important things like `Query`.
        ...objMerge(
          this.getProviders().map((p) => p.getTypeResolvers({ schemaName })),
        ),
        Query: objMerge(
          this.getProviders().map((p) => p.getQueryResolvers({ schemaName })),
        ),
        Mutation: objMerge(
          this.getProviders().map((p) =>
            p.getMutationResolvers({ schemaName }),
          ),
        ),
        Subscription: objMerge(
          this.getProviders().map((p) =>
            p.getSubscriptionResolvers({ schemaName }),
          ),
        ),
        Upload: GraphQLUpload,
      },
      (o) => Object.entries(o).length > 0,
    );
  }

  dumpSchema(schemaName = "public") {
    return this.getTypeDefs({ schemaName })
      .map((t) => print(t))
      .join("\n");
  }

  async getMiddlewares({ dev, apps, distDir, pinoOptions, cors, logger }) {
    logger("Tạo các hàm Middlewares");
    const { DEFAULT_DIST_DIR } = envConf();
    const middlewares = [];

    /* app version */
    if (this.appVersion.addVersionToHttpHeaders) {
      const versionMiddleware = appVersionMiddleware(this.appVersion.version);
      logger("App Version");
      middlewares.push(versionMiddleware);
    }

    /* logger */
    if (falsey(process.env.DISABLE_LOGGING)) {
      logger("Pino Logger");
      const loggerMiddleware = pinoLogger(pinoOptions);
      middlewares.push(loggerMiddleware);
    }

    /* cors */
    if (cors) {
      logger("Cors");
      const corsMiddleware = createCorsMiddleware();
      middlewares.push(corsMiddleware);
    }

    /*
     * jwt
     */
    if (this.jwt) {
      logger("JWT");
      // const jwtMiddleware = createJWTMiddlewareV2(this.jwt);
      // middlewares.push(jwtMiddleware);
    }

    const sessions =
      this?._sessionManager?.getSessionMiddleware({ ocop: this }) || [];
    for (const middleware of sessions) {
      logger(`${middleware.name}`);
      middlewares.push(middleware);
    }

    /* apps */
    for (const app of apps) {
      logger(`${app.constructor.name}`);

      const middleware = await app.getMiddleware({
        ocop: this,
        dev,
        distDir: distDir || DEFAULT_DIST_DIR,
      });
      middlewares.push(middleware);
    }

    return middlewares.filter((middleware) => !!middleware);

    return flattenDeep([
      // this.appVersion.addVersionToHttpHeaders &&
      // appVersionMiddleware(this.appVersion.version),
      // Used by other middlewares such as authentication strategies. Important
      // to be first so the methods added to `req` are available further down
      // the request pipeline.
      // TODO: set up a session test rig (maybe by wrapping an in-memory store)
      // this._sessionManager.getSessionMiddleware({ ocop: this }),
      // this._sessionManager.getMiddlewares({ ocop: this }),
      // falsey(process.env.DISABLE_LOGGING) &&
      // require("express-pino-logger")(pinoOptions),
      // cors && createCorsMiddleware(cors),
      ...(await Promise.all(
        [
          // Inject any field middlewares (eg; WYSIWIG's static assets)
          // We do this first to avoid it conflicting with any catch-all routes the
          // user may have specified
          ...this.registeredTypes,
          // ...flattenDeep(
          //   Object.values(this.auth).map((authStrategies) =>
          //     Object.values(authStrategies)
          //   ),
          // ),
          // ...apps,
        ]
          .filter(({ getMiddleware } = {}) => !!getMiddleware)
          .map((app) =>
            app.getMiddleware({
              ocop: this,
              dev,
              distDir: distDir || DEFAULT_DIST_DIR,
            }),
          ),
      )),
    ]).filter((middleware) => !!middleware);
  }

  async prepare({
    dev = false,
    apps = [],
    distDir,
    pinoOptions,
    cors = { origin: true, credentials: true },
    logger,
  } = {}) {
    const server = this.createApolloServer({ schemaName: "internal", logger });

    const middlewares = await this.getMiddlewares({
      dev,
      apps,
      distDir,
      pinoOptions,
      cors,
      logger,
    });

    // These function can't be called after prepare(), so make them throw an error from now on.
    ["extendGraphQLSchema", "createList", "createAuthStrategy"].forEach((f) => {
      this[f] = () => {
        throw new Error(`ocop.${f} must be called before ocop.prepare()`);
      };
    });

    return { server, middlewares };
  }
}
