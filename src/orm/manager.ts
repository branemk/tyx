import { Connection, ConnectionOptions, EntityManager, SelectQueryBuilder, createConnection, getConnection } from "typeorm";
import { Configuration } from "../base";
import { Inject, Service } from "../decorators/service";
import { ToolkitArgs, ToolkitContext, ToolkitInfo, ToolkitProvider, ToolkitQuery } from "../graphql";
import { Logger } from "../logger";
import { Context } from "../types/common";
import { Entity } from "./decorators";
import { EntityMetadata } from "./metadata";

export { Connection, ConnectionOptions, EntityManager, Repository } from "typeorm";

@Service("database")
export class Database implements Service, ToolkitProvider {

    private static instances = 0;

    @Inject(Configuration)
    public config: Configuration;

    @Logger()
    public log;
    public label: string;

    protected connection: Connection;
    public manager: EntityManager;

    public get entities(): Function[] { return Entity.list(this); }

    public get metadata(): EntityMetadata[] { return this.connection.entityMetadatas; }

    public getMetadata(entity: string | Function): EntityMetadata {
        return this.connection.getMetadata(entity);
    }

    public async initialize(options?: string | ConnectionOptions): Promise<void> {
        if (!this.log) this.log = Logger.get("database", this);
        options = options || this.config && this.config.database || "default";
        if (typeof options === "string" && !options.includes("@")) {
            this.label = options;
            this.connection = await getConnection(options);
            this.manager = this.connection.manager;
            return;
        }
        if (typeof options === "string") {
            this.label = options.substring(options.indexOf("@") + 1);
            let tokens = options.split(/:|@|\/|;/);
            let logQueries = tokens.findIndex(x => x === "logall") > 5;
            let name = (this.config && this.config.appId || "tyx") + "#" + (++Database.instances);
            options = {
                name,
                username: tokens[0],
                password: tokens[1],
                type: tokens[2] as any,
                host: tokens[3],
                port: +tokens[4],
                database: tokens[5],
                // timezone: "Z",
                logging: logQueries ? "all" : ["error"],
                entities: this.entities
            };
        } else {
            this.label = "" + (options.name || options.database);
            options = { ...options, entities: options.entities || this.entities };
        }
        this.connection = await createConnection(options);
        this.manager = this.connection.manager;
    }

    public async activate(ctx: Context) {
        this.log.info("Connect: [%s]", this.label);
        if (!this.connection.isConnected) await this.connection.connect();
    }

    public async release(ctx: Context) {
        this.log.info("Close: [%s]", this.label);
        try {
            await this.connection.close();
        } catch (e) {
            this.log.error(e);
        }
    }

    // Schema provider interface

    public create(type: string, obj: ToolkitArgs, args: ToolkitArgs, context: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        let record = this.manager.create<any>(type, args);
        // TODO: Generate PK
        return this.manager.save(record);
    }

    public update(type: string, obj: ToolkitArgs, args: ToolkitArgs, context: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        let record = this.manager.create(type, args);
        // TODO: Generate PK
        return this.manager.save(record);
    }

    public remove(type: string, obj: ToolkitArgs, args: ToolkitArgs, context: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        let record = this.manager.create(type, args);
        // TODO: Generate PK
        return this.manager.remove(record);
    }

    public get(type: string, obj: ToolkitArgs, args: ToolkitArgs, context: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        return this.prepareQuery(type, args, null, context).getOne();
    }

    public search(type: string, obj: ToolkitArgs, args: ToolkitQuery, context: ToolkitContext, info?: ToolkitInfo): Promise<any[]> {
        return this.prepareQuery(type, null, args, context).getMany();
    }

    public oneToMany(type: string, rel: string, root: ToolkitArgs, query: ToolkitQuery, context?: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        let entity = this.manager.connection.getMetadata(type);
        let relation = entity.relations.find(r => r.propertyName === rel);
        let target = relation.inverseEntityMetadata.name;
        let pks = relation.entityMetadata.primaryColumns.map(col => col.propertyName);
        let fks = relation.inverseRelation.joinColumns.map(col => col.propertyName);
        let keys: any = {};
        fks.forEach((fk, i) => keys[fk] = root[pks[i]]);
        return this.prepareQuery(target, keys, query, context).getMany();
    }

    public oneToOne(type: string, rel: string, root: ToolkitArgs, query: ToolkitQuery, context: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        let entity = this.manager.connection.getMetadata(type);
        let relation = entity.relations.find(r => r.propertyName === rel);
        let target = relation.inverseEntityMetadata.name;
        let pks = relation.inverseEntityMetadata.primaryColumns.map(p => p.propertyName);
        let fks = relation.joinColumns.length ?
            relation.joinColumns.map(col => col.propertyName) :
            relation.entityMetadata.primaryColumns.map(col => col.propertyName);
        let keys: any = {};
        pks.forEach((pk, i) => keys[pk] = root[fks[i]]);
        return this.prepareQuery(target, keys, query, context).getOne();
    }

    public manyToOne(type: string, rel: string, root: ToolkitArgs, query: ToolkitQuery, context: ToolkitContext, info?: ToolkitInfo): Promise<any> {
        let entity = this.manager.connection.getMetadata(type);
        let relation = entity.relations.find(r => r.propertyName === rel);
        let target = relation.inverseEntityMetadata.name;
        let pks = relation.inverseEntityMetadata.primaryColumns.map(p => p.propertyName);
        let fks = relation.joinColumns.map(col => col.propertyName);
        let keys: any = {};
        pks.forEach((pk, i) => keys[pk] = root[fks[i]]);
        return this.prepareQuery(target, keys, query, context).getMany();
    }

    public prepareQuery(type: string, keys: ToolkitArgs, query: ToolkitQuery, context: ToolkitContext): SelectQueryBuilder<any> {
        let sql = ToolkitQuery.prepareSql(keys, query);
        let builder: SelectQueryBuilder<any> = this.manager.createQueryBuilder(type, ToolkitQuery.ALIAS)
            .where(sql.where, sql.params);
        sql.order.forEach(ord => builder.addOrderBy(ord.column, ord.asc ? "ASC" : "DESC"));
        if (sql.skip) builder.skip(sql.skip);
        if (sql.take) builder.take(sql.take);
        return builder;
    }
}
