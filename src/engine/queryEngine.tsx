import { EmptySmartRs, RsData, SmartRs } from "./chartResultSet";
import { LRUBuffer, Websocket, WebsocketBuilder } from 'websocket-ts';
import { Button, MaybeElement } from '@blueprintjs/core';
import { useContext, useEffect, useRef, useState } from 'react';
import { ServerConfig } from "../components/ConnectionsPage";
import { sql } from '@codemirror/lang-sql';
import {EditorView, KeyBinding, keymap } from "@codemirror/view"
import { oneDark } from '@codemirror/theme-one-dark';

import { ThemeContext } from './../context';
import axios from "axios";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "./myCodemirrorBasic";
import { useCallback } from 'react';
import { ASelectSingle, IOptionRow } from "../components/AForm";

function urlToArgs(queryString:string) {
	let m:{ [argKey: string]: string[] }  = {};
	if(queryString.length>0) {
		const sp = new URLSearchParams(queryString);
		sp.forEach((v,k) => {
			let s = sp.get(k);
			if(s !== null) {
				m[k] = v.split("_");
			}
		});
	}
	return m;
}
/**
 * QueryEngine represents the full querying engine where all events happen.
 * Most users should use UpdatingQueryable to listen/edit one query. 
 * Mostly the QueryEngine should use websockets to receive updates dynamicallly.
 * Alternatively the websocket can be turned off and then sendQuery can be used to send single specific queries.
 * Useful for reusing the listener logic in a single query editor.
 */
export default class QueryEngine {

	private notifyListeners(queryable: Queryable, srs: SmartRs | null, err: string = "") {
		// console.debug("QE: notify " + this.listeners.length + " Listeners(" + queryable.query + "," + srs?.count() + " rows)");
		this.listeners.forEach(l => {
			try {
				srs === null ? l.queryError(queryable, err) : l.tabChanged(queryable, srs);
			} catch (error) {
				console.error("Error notifying listener" + error);
			}
		});
	}

	private intervalID: NodeJS.Timeout | null = null;
	private listeners: Array<QueryEngineListener> = [];
	public queryables: Array<Queryable> = [];
	private queryLastResultCache: { [s: string]: RsData } = {};
	private ws: Websocket | undefined = undefined;
	public argMap: { [argKey: string]: string[] } = {};

	constructor(firstListener: QueryEngineListener | null = null, connectToWebsocket = true, queryString:string = "") {
		if (firstListener !== null) { this.addListener(firstListener); }
		this.argMap = {...this.argMap, ...urlToArgs(queryString)};
		if(connectToWebsocket) {
			this.ws = this.requestReconnect();
		}
	}

	requestReconnect = () => {
		if (this.ws === undefined || this.isClosed()) {
			let ws = new WebsocketBuilder('ws://' + window.location.host + '/subscribe/mysub')
				.withBuffer(new LRUBuffer(1000))
				.onOpen((i, ev) => {
					console.log("opened");
					this.listeners.forEach(l => l.connectionChange(true));
					// TODO in case of disconnect we may need this?
					Object.keys(this.argMap).forEach((argKey) => ws.send("setk:" + JSON.stringify({ argKey, argVals: this.argMap[argKey] })));
				})
				.onClose((i, ev) => { console.log("closed"); this.listeners.forEach(l => l.connectionChange(false)); })
				.onError((i, ev) => { console.log("error") })
				.onMessage((i, ev) => { this.handleEvent(ev); })
				.build();
			this.ws = ws;
		}
		return this.ws;
	}

	isClosed = () => { return this.ws ? this.ws.underlyingWebsocket?.readyState === WebSocket.CLOSED : true; }

	shutDown() {
		this.listeners = [];
		clearInterval(this.intervalID!);
		this.ws?.close();
	}

	addListener(listener: QueryEngineListener) { this.listeners.push(listener); }
	addQueryable(queryable: Queryable) {
		this.queryables.push(queryable);
		this.ws?.send("addq:" + JSON.stringify(queryable));
		if (this.queryLastResultCache[queryable.query]) {
			let rsdata = this.queryLastResultCache[queryable.query];
			this.notifyListeners(queryable, new SmartRs(rsdata));
		}
	}

	removeListener(listener: QueryEngineListener) {
		this.listeners = this.listeners.filter(ql => ql !== listener);
	}

	removeQueryable(queryable: Queryable) {
		this.ws?.send("subq:" + JSON.stringify(queryable));
		this.queryables = this.queryables.filter(ql => ql !== queryable);
	}

	setArg(argKey: string, argVals: string[]) {

		console.log(argKey + "===>" + argVals);
		let newUrl = addParameter(window.location.href,argKey,argVals.length>0 ? argVals.map(s=>s.replaceAll("_","__")).join("_") : "");
		window.history.replaceState({}, '', newUrl);

		this.argMap[argKey] = argVals;
		this.listeners.forEach(l => {
			try {
				l.argChange(argKey, argVals);
			} catch (error) {
				console.error("Error notifying listener" + error);
			}
		});
		this.ws?.send("setk:" + JSON.stringify({ argKey, argVals }));
	}

	handleEvent(ev: MessageEvent<any>) {
		if (typeof ev.data === "string") {
			try {
				if(ev.data.startsWith("addq:") || ev.data.startsWith("subq:") || ev.data.startsWith("setk:")) {
					return; // Ignore it's just an ACK
				}
				let d = JSON.parse(ev.data);
				let queryable: Queryable = d.queryable;
				if (d.hasOwnProperty("error") && d.error && typeof d.error === "string") {
					this.notifyListeners(queryable, null, d.error);
				} else {
					let rsdata: RsData = d.data;
					this.notifyListeners(queryable, new SmartRs(rsdata));
					this.queryLastResultCache[queryable.query] = rsdata;
					if (Object.keys(this.queryLastResultCache).length > 1000) {
						this.queryLastResultCache = {};
					}
				}
			} catch (error) {
				console.log("Error processing response:" + error);
			}
		}
	}

	public async sendQuery(queryable: Queryable) {
		console.log("qe2-sendQuery " + queryable?.query);
		let a = await axios.get<RsData>(SERVER + "/a.json", { params: { server: queryable?.serverName, query: queryable?.query } });
		try {
			let rsdata: RsData = a.data;
			this.notifyListeners(queryable, new SmartRs(rsdata));
		} catch (error) {
			let err = ((error instanceof Error) ? error.message : 'Unknown Error');
			console.log("Error processing response:" + err);
			this.notifyListeners(queryable, null, err);
		}
	}
}

function addParameter(url:string, parameterName:string, parameterValue:string, atStart:boolean = false):string {
    let replaceDuplicates = true;
	let urlhash = '';
	let cl = url.length;
    if(url.indexOf('#') > 0) {
        cl = url.indexOf('#');
        urlhash = url.substring(url.indexOf('#'),url.length);
    }
    let sourceUrl = url.substring(0,cl);

    var urlParts = sourceUrl.split("?");
    var newQueryString = "";

    if (urlParts.length > 1) {
        var parameters = urlParts[1].split("&");
        for (var i=0; (i < parameters.length); i++) {
            var parameterParts = parameters[i].split("=");
            if (!(replaceDuplicates && parameterParts[0] === parameterName)) {
				newQueryString = newQueryString === "" ? "?" : newQueryString+"&";
                newQueryString += parameterParts[0] + "=" + (parameterParts[1]?parameterParts[1]:'');
            }
        }
    }
    if (newQueryString === "")
        newQueryString = "?";

    if(atStart){
        newQueryString = '?'+ parameterName + "=" + parameterValue + (newQueryString.length>1?'&'+newQueryString.substring(1):'');
    } else {
        if (newQueryString !== "" && newQueryString !== '?')
            newQueryString += "&";
        newQueryString += parameterName + "=" + (parameterValue?parameterValue:'');
    }
    return urlParts[0] + newQueryString + urlhash;
};

export function isSameQuery(p: Queryable, q: Queryable): boolean {
	return p.serverName === q.serverName && p.query === q.query;
}

export class Queryable {
	constructor(readonly serverName: string, readonly query: string, readonly refreshPeriod: number) { }
}

export interface QueryEngineListener {
	tabChanged(queryable: Queryable, qTab: SmartRs): void;
	queryError(queryable: Queryable, exception: string): void;
	argChange(argKey: string, argVals: string[]): void;
	connectionChange(connected: boolean): void;
}


export class QueryEngineAdapter implements QueryEngineListener {
	tabChanged(queryable: Queryable, qTab: SmartRs): void { }
	queryError(queryable: Queryable, exception: string): void { }
	argChange(key: string, newValue: any): void { }
	connectionChange(connected: boolean): void { }

}


export const HHOST = 'localhost';
export const SERVE = ''; // HHOST + ':80';
export const SERVER = ''; // 'http://' + SERVE;




/*****************  UpdatingQueryable  - Allows listening/editing one query and ignoring connections etc. ***********************/


export interface UpdatingQueryableListener {
	update(srs: SmartRs, exception: string | undefined): void
}


/** Given an array of servers, return index which would be the most sensible one to make the selected default. */
export function getSensibleServerIdx(serverConfigs:ServerConfig[]) {
	let names = serverConfigs.map(sc => sc.name);
	// Try 1. Latest used name 2. First one found unless it's demo 3. Second one.
	let serverName = "";
	let lastName = window.localStorage.getItem("LastServerConfigsName");
	if(lastName !== null && names.includes(lastName)) {
		serverName = lastName;
	} else if(serverConfigs.length > 0) {
		serverName = serverConfigs[0].name;
		if(serverName === "DEMODB" && serverConfigs.length > 1) {
			serverName = serverConfigs[1].name;
		}
	}
	return serverName !== undefined ? names.indexOf(serverName) : undefined;
}

export class UpdatingQueryable implements QueryEngineListener {

	queryable: Queryable;
	private running = false;

	constructor(readonly serverConfigs: ServerConfig[], readonly queryEngine: QueryEngine,
		readonly listener: UpdatingQueryableListener, queryable: Queryable = new Queryable("", "([] name:`peter`paul`james; nice:(\"Peter Jones\";\"James Dunn\";\"James Rudolph\"))", 5000)) {
		this.queryable = queryable;
		// Assume any serverConfig is chosen
		if (queryable.serverName.length === 0 && this.serverConfigs.length > 0) {
			let o = this.queryable;
			let serverName = window.localStorage.getItem("LastServerConfigsName") || this.serverConfigs[0].name
			this.queryable = { ...o, serverName };
		}
	}

	argChange(key: string, newValue: any): void { }

	tabChanged(queryable: Queryable, srs: SmartRs): void {
		if (isSameQuery(this.queryable, queryable)) {
			this.listener.update(srs, undefined);
		}
	}
	queryError(queryable: Queryable, exception: string): void {
		if (isSameQuery(this.queryable, queryable)) {
			this.listener.update(EmptySmartRs, exception);
		}
	}

	saveQry = (queryable: Queryable) => {
		let o = this.queryable;
		this.queryEngine.removeQueryable(o);
		let n = { ...o, ...queryable };
		this.queryable = new Queryable(n.serverName, n.query, n.refreshPeriod);
		this.listener.update(EmptySmartRs, undefined);
		this.queryEngine.addQueryable(this.queryable);
	}

	connectionChange(connected: boolean) {
		if (!connected) {
			this.listener.update(EmptySmartRs, "disconnected");
		}
	}

	start() {
		if (!this.running) {
			console.debug("UpdatingQueryable: starting query = " + this.queryable.query)
			this.running = true;
			this.queryEngine.addListener(this);
			this.queryEngine.addQueryable(this.queryable);
		} else {
			console.log("You tried to start an already started UpdatingQueryable");
		}
	}

	stop() {
		if (this.running) {
			console.debug("UpdatingQueryable: stopping query = " + this.queryable.query)
			this.running = false;
			this.queryEngine.removeListener(this);
			this.queryEngine.removeQueryable(this.queryable);
		} else {
			console.log("You tried to stop an already stopped UpdatingQueryable");
		}
	}

	getEditor(children: MaybeElement) {
		return <QueryableEditor queryable={this.queryable} serverConfigs={this.serverConfigs} sendQuery={this.saveQry}>
			{children}
		</QueryableEditor>;
	}
}


export type SqlEditorProps = { 
	value:string, 
	runLine: (line: string) => void, 
	runSelection: (selection: string) => void,
    onChange:(txt:string) => void
};
const SqlEditor = (props:SqlEditorProps ) => {
	const editor = useRef<HTMLDivElement>(null);
	const { value, onChange } = props;
    const context = useContext(ThemeContext);
	const runLineRef = useRef(props.runLine);
	const runSelectionRef = useRef(props.runSelection);

	// We don't want to keep redefining codemirror BUT we do want to call latest callback with new server etc.
	runLineRef.current = props.runLine;
	runSelectionRef.current = props.runSelection;

	useEffect(() => {
		let myKeyMap:KeyBinding[] = [{key:"Ctrl-s",   run:() => { runSelectionRef.current("s"); return true; }, preventDefault:true },
								 {key:"Ctrl-e",  preventDefault:true,
								 	run:(v: EditorView) => { 
											const m = v.state.selection.main;
											const txt = m['from']<m['to'] ? v.state.doc.sliceString(m['from'],m['to']) : v.state.doc.sliceString(0);
											runSelectionRef.current(txt); 
											return true; 
									}},
								{key:"Ctrl-Enter",run:(v: EditorView) => { runLineRef.current(v.state.doc.lineAt(v.state.selection.main.head).text); return true; }, preventDefault:true, mac:"Cmd-Enter", win:"Ctrl-Enter" }];
									
		
		let updateListenerExtension = EditorView.updateListener.of((update) => {
			if (update.docChanged) { onChange(view.state.doc.toString()); } 
		});
		let extensions = [sql(),keymap.of(myKeyMap),updateListenerExtension,basicSetup];
		if(context.theme === "dark") {
			extensions.push(oneDark);
		}
		const state = EditorState.create({ doc: value, extensions });
	  	const view = new EditorView({ state, parent: editor.current ?? undefined });
		view.focus();
		return () => { view.destroy(); };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [context.theme]);
	// If I include those dependencies the editor doesn't work. Can't type.
  
	return (<div className="SqlEditor" ref={editor} ></div>);
  }


export const QueryableEditor = (props: { queryable: Queryable, serverConfigs: ServerConfig[], children?: MaybeElement, sendQuery: (queryable: Queryable) => void, showRefreshSelect?:boolean }) => {

	const [dirtyQuery, setDirtyQuery] = useState(props.queryable.query);
    const [queryable, setQueryable] = useState<Queryable>(props.queryable);
	const { sendQuery } = props;
	const {serverName,refreshPeriod } = queryable;
	const showRefresh = props.showRefreshSelect === undefined ? true : props.showRefreshSelect === true;

	const sendSqlQuery = useCallback((qry:string) => { 
		if(qry && qry.length>0) {
			sendQuery({ serverName, refreshPeriod, query: qry } as Queryable);
		}
		return true; 
	},[sendQuery,serverName,refreshPeriod]);
	
	const run = useCallback((t:string) => t && t.length>0  && sendSqlQuery(t),[sendSqlQuery]);
	const refreshOptions:IOptionRow[] = [{val:"0", niceName:"As fast as possible"},{val:"100", niceName:"Every 100ms"},{val:"1000", niceName:"Every 1s"},{val:"5000", niceName:"Every 5s"},{val:"30000", niceName:"Every 30s"},{val:"999999", niceName:"Only on Interaction"}];
	const selectArgs = refreshOptions.find(o => o.val === ""+(queryable.refreshPeriod ?? ""));

	return (<div>
		{props.children}
		<div className="QueryableEditorControls">
			<div><label>Server:</label>
				<ServerSelect selectedServer={props.queryable.serverName} serverOptions={props.serverConfigs}
					onSelect={e => { setQueryable({ ...queryable, serverName: e} as Queryable) }} />
				{showRefresh && <ASelectSingle options={refreshOptions} onArgSelected={(e)=>{setQueryable({...queryable, refreshPeriod:parseInt(e[0])})}} selectedArgs={selectArgs ? [selectArgs] : []} />}
			</div>
			<Button icon="arrow-right" intent="success" style={{ marginBottom: 5 }} onClick={() => sendSqlQuery(dirtyQuery)}>Save Query</Button>
		</div>
		<SqlEditor 
			runLine={run} 
			runSelection={run} 
			value={dirtyQuery} 
			onChange={(txt) => {setDirtyQuery(txt); }}  />
	</div>);
}


function ServerSelect(props: { selectedServer: string, serverOptions: ServerConfig[], onSelect: (serverName: string) => void }) {

	function onlyUnique(value: any, index: number, self: any) {
		return self.indexOf(value) === index;
	}
	const options = [props.selectedServer, ...props.serverOptions.map(sc => sc.name)].filter(onlyUnique);

	return (<>
		<select title="server select" onChange={e => {
			window.localStorage.setItem("LastServerConfigsName", e.currentTarget.value); // Reuse users latest choice
			props.onSelect(e.currentTarget.value)
		}}>
			{options.map(s => <option selected={s === props.selectedServer} key={s}>{s}</option>)}
		</select>
	</>);
}
