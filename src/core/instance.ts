import { Configuration, CoreConfiguration, CoreSecurity, Security } from "../core";
import { Service } from "../decorators";
import { Container, ContainerInstance } from "../di";
import { InternalServerError, NotFound } from "../errors";
import { Logger } from "../logger";
import { Metadata, MethodMetadata, ProxyMetadata, ServiceMetadata } from "../metadata";
import { Class, ContainerState, Context, Core, EventRequest, EventResult, HttpRequest, HttpResponse, ObjectType, RemoteRequest } from "../types";
import { HttpUtils, Utils } from "../utils";

export class CoreInstance implements Core {
    private application: string;
    private name: string;
    private log: Logger;

    private container: ContainerInstance;
    private config: Configuration;
    private security: Security;
    private istate: ContainerState;

    constructor(application: string, name: string, index?: string) {
        this.application = application;
        this.name = name || CoreInstance.name;
        if (index !== undefined) this.name += ":" + index;

        this.container = Container.of(this.name);

        this.log = Logger.get(this.application, this.name);
        this.istate = ContainerState.Pending;
    }

    public get state() {
        return this.istate;
    }

    public get<T>(type: ObjectType<T> | string): T {
        if (typeof type === "string") return this.container.get<T>(type);
        let proxy = ProxyMetadata.get(type);
        if (proxy) return this.container.get(proxy.alias);
        let service = ServiceMetadata.get(type);
        if (service) return this.container.get(service.alias);
        return undefined;
    }

    public register(target: Class | Object): this {
        if (this.istate !== ContainerState.Pending) throw new InternalServerError("Invalid container state");
        return this;
    }

    public publish(target: Class | Object): this {
        if (this.istate !== ContainerState.Pending) throw new InternalServerError("Invalid container state");
        return this;
    }

    public async prepare(): Promise<this> {
        if (this.istate !== ContainerState.Pending) throw new InternalServerError("Invalid container state");

        if (!Container.has(Configuration)) {
            this.log.warn("Using default configuration service!");
            this.container.set({ id: Configuration, type: CoreConfiguration });
        }
        this.config = this.container.get(Configuration);
        if (this.config instanceof CoreConfiguration) {
            this.config.init(this.application);
        } else if (!ServiceMetadata.has(this.config)) {
            throw new InternalServerError(`Configuration must be a service`);
        }

        if (!Container.has(Security)) {
            this.log.warn("Using default security service!");
            this.container.set({ id: Security, type: CoreSecurity });
        }
        this.security = this.container.get(Security);
        if (this.security instanceof CoreSecurity) {
            // OK
        } else if (!ServiceMetadata.has(this.security)) {
            throw new InternalServerError(`Security must be a service`);
        }

        this.istate = ContainerState.Ready;
        return this;
    }

    // --------------------------------------------------

    public async remoteRequest(req: RemoteRequest): Promise<any> {
        if (this.istate !== ContainerState.Ready) throw new InternalServerError("Invalid container state");

        this.istate = ContainerState.Reserved;
        try {
            this.log.debug("Remote Request: %j", req);

            if (req.application !== this.application) throw this.log.error(new NotFound(`Application not found [${req.application}]`));
            let service = this.container.get(req.service);
            if (!service) throw this.log.error(new NotFound(`Service not found [${req.service}]`));
            let methodId = req.service + "." + req.method;
            let metadata = Metadata.methods[methodId];
            if (!metadata) throw this.log.error(new NotFound(`Method not found [${methodId}]`));

            this.istate = ContainerState.Busy;
            let ctx = await this.security.remoteAuth(this, req, metadata);

            let log = Logger.get(service);
            let startTime = log.time();
            try {
                await this.activate(ctx);
                let handler: Function = service[metadata.name];
                let result = await handler.apply(service, req.args);
                return result;
            } catch (e) {
                throw this.log.error(e);
            } finally {
                log.timeEnd(startTime, `${metadata.name}`);
                await this.release(ctx);
            }
        } finally {
            this.istate = ContainerState.Ready;
        }
    }

    public async eventRequest(req: EventRequest): Promise<EventResult> {
        if (this.istate !== ContainerState.Ready) throw new InternalServerError("Invalid container state");

        this.istate = ContainerState.Reserved;
        try {
            req.type = "event";
            this.log.debug("Event Request: %j", req);

            let route = `${req.source} ${req.resource}`;
            let alias = this.config.resources && this.config.resources[req.resource];
            let metadatas = Metadata.events[route];
            if (!metadatas) {
                route = `${req.source} ${alias}`;
                metadatas = Metadata.events[route];
            }
            if (!metadatas) throw this.log.error(new NotFound(`Event handler not found [${route}] [${req.object}]`));

            let result: EventResult = {
                status: null,
                source: req.source,
                action: req.action,
                resource: req.resource,
                object: req.object,
                returns: []
            };

            this.istate = ContainerState.Busy;
            for (let target of metadatas) {
                let service = this.container.get(target.service);
                if (!service) throw this.log.error(new NotFound(`Service not found [${req.service}]`));
                let methodId = target.service + "." + target.method;
                let method = Metadata.methods[methodId];

                if (!Utils.wildcardMatch(target[route].actionFilter, req.action)
                    || !Utils.wildcardMatch(target[route].objectFilter, req.object)) continue;

                req.application = this.application;
                req.service = target.service;
                req.method = target.method;

                let ctx = await this.security.eventAuth(this, req, method);

                let log = Logger.get(service);
                let startTime = log.time();
                try {
                    await this.activate(ctx);
                    for (let record of req.records) {
                        req.record = record;
                        let handler = service[target.method];
                        let data: any;
                        if (target.adapter) {
                            data = await target.adapter(handler.bind(service), ctx, req);
                        } else {
                            data = await handler.call(service, ctx, req);
                        }
                        result.status = result.status || "OK";
                        result.returns.push({
                            service: target.service,
                            method: target.method,
                            error: null,
                            data
                        });
                    }
                } catch (e) {
                    this.log.error(e);
                    result.status = "FAILED";
                    result.returns.push({
                        service: target.service,
                        method: target.method,
                        error: InternalServerError.wrap(e),
                        data: null
                    });
                } finally {
                    log.timeEnd(startTime, `${target.method}`);
                    await this.release(ctx);
                }
            }
            result.status = result.status || "NOP";
            return result;
        } finally {
            this.istate = ContainerState.Ready;
        }
    }

    public async httpRequest(req: HttpRequest): Promise<HttpResponse> {
        if (this.istate !== ContainerState.Ready) throw new InternalServerError("Invalid container state");

        this.istate = ContainerState.Reserved;
        try {
            req.type = "http";
            this.log.debug("HTTP Event: %j", req);

            HttpUtils.request(req);

            let route = `${req.httpMethod} ${req.resource}`;
            if (req.contentType.domainModel) route += `:${req.contentType.domainModel}`;
            let target = Metadata.routes[route];
            if (!target) throw this.log.error(new NotFound(`Route not found [${route}]`));
            let service = this.container.get(target.service);
            if (!service) throw this.log.error(new NotFound(`Service not found [${req.service}]`));
            let methodId = target.service + "." + target.method;
            let method = Metadata.methods[methodId] as MethodMetadata;

            req.application = this.application;
            req.service = target.service;
            req.method = target.method;

            this.istate = ContainerState.Busy;
            let ctx = await this.security.httpAuth(this, req, method);

            let log = Logger.get(service);
            let startTime = log.time();
            try {
                await this.activate(ctx);

                this.log.debug("HTTP Context: %j", ctx);
                this.log.debug("HTTP Request: %j", req);

                let handler: Function = service[method.name];
                let http = method.http[route];
                let result: any;
                if (http.adapter) {
                    result = await http.adapter(
                        handler.bind(service),
                        ctx,
                        req,
                        req.pathParameters || {},
                        req.queryStringParameters || {});
                } else {
                    let args: any = [];
                    for (let [index, arg] of method.bindings.entries()) {
                        args[index] = (arg.binder ? arg.binder(ctx, req) : undefined);
                    }
                    result = await handler.apply(service, args);
                }

                let contentType = method.contentType || "application/json";
                if (contentType !== HttpResponse) result = { statusCode: http.code, body: result, contentType };
                if (ctx && ctx.auth.renewed && ctx.auth.token) {
                    result.headers = result.headers || {};
                    result.headers["Token"] = ctx.auth.token;
                }
                this.log.debug("Response: %j", result);
                return result;
            } catch (e) {
                this.log.error(e);
                throw InternalServerError.wrap(e);
            } finally {
                log.timeEnd(startTime, `${method.name}`);
                await this.release(ctx);
            }
        } finally {
            this.istate = ContainerState.Ready;
        }
    }

    public async activate(ctx: Context): Promise<Context> {
        for (let sid in Metadata.services) {
            let service = this.container.get<Service>(sid);
            try {
                if (service.activate) await service.activate(ctx);
            } catch (e) {
                this.log.error("Failed to activate service: [%s]", sid);
                this.log.error(e);
                throw e;
                // TODO: Error state for container
            }
        }
        return ctx;
    }

    public async release(ctx: Context): Promise<void> {
        for (let sid in Metadata.services) {
            let service = this.container.get<Service>(sid);
            try {
                if (service.release) await service.release(ctx);
            } catch (e) {
                this.log.error("Failed to release service: [%s]", sid);
                this.log.error(e);
                // TODO: Error state for container
            }
        }
    }
}


