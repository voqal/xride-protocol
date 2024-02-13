// XRide Protocol Framework

export interface IXRideConfig {
    webSocketURL?: string;
    onDataChannelMessage?: (data: any) => void;
    transmitAudio?: boolean
}

export interface IXRideText {
    fontSize: number;
    content: string;
    fontColor: string;
}

export interface IXRideContent {
    content: any;
}

export class IXRideTextContent implements IXRideContent {
    content: Array<IXRideText>;

    constructor(content: Array<IXRideText>) {
        this.content = content;
    }
}

export class IXRideImageContent implements IXRideContent {
    content: string;
    image: HTMLImageElement;

    constructor(content: string) {
        this.content = content;
        this.image = new Image();
        this.image.src = "data:image/png;base64," + content;
    }

    getImage(): HTMLImageElement {
        return this.image;
    }
}

type EditorStateChangeType = "content" | "visible" | "selected" | "disposed";
type EditorStateChangeListener = (editor: Editor, type: EditorStateChangeType) => void;

type EditorChangeType = "add_editor" | "remove_editor" | "hide_editors" | "show_editors" | "selected_editor" | "file";
type EditorChangeListener = (number: number, editor: Editor, type: EditorChangeType) => void;

export class Editor {
    private disposed: boolean = false;
    private visible: boolean = true;
    private selected: boolean = false;
    private content: IXRideContent;
    private listeners: EditorStateChangeListener[] = [];

    constructor(content: IXRideContent) {
        this.content = content;
    }

    setContent(content: IXRideContent) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.content = content;
        this.notifyListeners("content");
    }

    getContent(): IXRideContent {
        return this.content;
    }

    addListener(listener: EditorStateChangeListener) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.listeners.push(listener);
    }

    setVisible(visible: boolean) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        } else if (this.visible === visible) {
            return; //no change
        }
        this.visible = visible;
        this.notifyListeners("visible");
    }

    isVisible(): boolean {
        return this.visible;
    }

    setSelected(selected: boolean) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        } else if (this.selected === selected) {
            return; //no change
        }
        this.selected = selected;
        this.notifyListeners("selected");
    }

    isSelected(): boolean {
        return this.selected;
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    dispose() {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.disposed = true;
        this.notifyListeners("disposed");
    }

    private notifyListeners(type: EditorStateChangeType) {
        this.listeners.forEach(listener => listener(this, type));
    }
}

export class XRideProtocol {
    private ws: WebSocket;
    private pc: RTCPeerConnection;
    private config: IXRideConfig;
    private dc?: RTCDataChannel;
    private localStream: MediaStream[] = []
    // @ts-ignore
    private receivedChunkMap = new Map<number, any[]>();
    // @ts-ignore
    private editors: Map<number, Editor> = new Map();
    private sessionId: string = "";
    private listeners: EditorChangeListener[] = [];

    constructor(config: IXRideConfig) {
        this.config = {
            webSocketURL: config.webSocketURL || 'wss://repobuoy.com:8080/myapp',
            transmitAudio: config.transmitAudio || true,
            ...config
        };
        this.pc = new RTCPeerConnection();
        this.ws = new WebSocket(this.config.webSocketURL!!);

        if (config.transmitAudio) {
            console.log("Getting media devices")
            navigator.mediaDevices
                .getUserMedia({video: false, audio: true})
                .then((stream) => {
                    console.log("Found user media")
                    this.localStream.push(stream)
                    this.setupWebSocket();
                    this.setupPeerConnection();
                })
                .catch((err) => {
                    console.error(`Failed to get user media: ${err}`);
                })
        } else {
            console.log("Not getting media devices")
            this.setupWebSocket();
            this.setupPeerConnection();
        }
    }

    connect(sessionToConnect: string) {
        console.log('Connecting to session: ' + sessionToConnect);
        this.ws.send(JSON.stringify({
            message: "connect",
            sessionid: sessionToConnect
        }));
    }

    private setupWebSocket() {
        this.ws.onopen = () => {
            console.log('WebSocket connection opened');
        };

        this.ws.onmessage = (event: MessageEvent) => {
            const message = JSON.parse(event.data);
            switch (message.message) {
                case 'greeting':
                    this.handleGreeting(message);
                    break;
                case 'offer':
                    this.handleOffer(message.sdp, message.mySessionId, message.targetSessionId);
                    break;
                case 'answer':
                    this.handleAnswer(message.sdp);
                    break;
                case 'icecandidate':
                    this.handleIceCandidate(message.candidate);
                    break;
                default:
                    throw new Error('Unknown message type');
            }
        };
    }

    private handleGreeting(message: any) {
        this.sessionId = message.sessionid;
        console.log('Got session id: ' + this.sessionId)

        this.setupDataChannel();
        if (this.config.transmitAudio) {
            //wait to local stream to be ready
            let intervalID = setInterval(() => {
                if (this.localStream.length > 0) {
                    console.log('Got local audio stream')
                    let ac = new AudioContext()
                    let source = ac.createMediaStreamSource(this.localStream[0])
                    let destination = ac.createMediaStreamDestination()
                    source.connect(destination)
                    let stream = destination.stream

                    // Capture the stream from the audio element
                    // const stream2 = (audioElement as any).captureStream();
                    const audioTrack = stream.getAudioTracks()[0]
                    this.pc.addTrack(audioTrack, stream)

                    this.negotiate()

                    //auto-connect to session
                    //this.connect("0")

                    //stop interval
                    clearInterval(intervalID)
                } else {
                    console.log('Waiting for local audio stream')
                }
            }, 1000);
        } else {
            this.negotiate()
        }
    }

    private handleFile(data: any) {
        console.log('File chunk received: ', data.number + ' of ' + data.total)
        let receivedChunks = this.receivedChunkMap.get(data.id)
        if (receivedChunks == null) {
            receivedChunks = []
            this.receivedChunkMap.set(data.id, receivedChunks)
        }
        receivedChunks[data.number] = data.chunk

        if (data.number === data.total - 1) {
            let base64 = receivedChunks.join('')
            this.receivedChunkMap.delete(data.id)

            let binary = atob(base64)
            let audioFile = new Blob(
                [new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i))],
                {type: 'audio/mp3'},
            )
            this.playAudioFile(audioFile)
        }
    }

    private playAudioFile(file: any) {
        let url = URL.createObjectURL(file)
        let audio = new Audio(url)
        audio.play()
    }

    private removeEditor(index: number) {
        console.log("Removing editor: ", index)
        let editor = this.editors.get(index)
        if (editor) {
            editor.dispose();
            this.editors.delete(index);
        } else {
            console.error("Editor not found: ", index)
        }
    }

    private addImageEditor(index: number, content: string, visible: boolean) {
        if (this.editors.has(index)) {
            console.log("Updating editor (image): ", index)
            let editor = this.editors.get(index)!!;
            editor.setContent(new IXRideImageContent(content));
            editor.setVisible(visible);
        } else {
            console.log("Adding editor (image): ", index)
            let editor = new Editor(new IXRideImageContent(content));
            this.editors.set(index, editor);
            editor.setVisible(visible);
            this.notifyListeners(index, editor, "add_editor");
        }
    }

    private notifyListeners(index: number, editor: Editor, type: EditorChangeType) {
        this.listeners.forEach(listener => listener(index, editor, type));
    }

    addEditorChangeListener(listener: EditorChangeListener) {
        this.listeners.push(listener);
    }

    private doSelectEditor(index: number) {
        console.log("Setting selected editor: ", index)
        this.editors.forEach((editor, key) => {
            editor.setSelected(key === index);
        });
    }

    setSelectedEditor(index: number) {
        if (this.editors.get(index)?.isSelected()) {
            return //already selected
        }
        this.doSelectEditor(index)

        const json = {
            "number": index,
            "type": "selected_editor"
        }
        this.sendMessage(json)
    }

    private hideEditors() {
        this.editors.forEach((editor, index) => {
            editor.setVisible(false)
        });
    }

    private showEditors() {
        this.editors.forEach((editor, index) => {
            editor.setVisible(true)
        });
    }

    private negotiate() {
        this.pc.createOffer()
            .then(offer => {
                this.pc.setLocalDescription(offer);
                this.ws.send(JSON.stringify({
                    message: "offer",
                    sdp: offer
                }));
            });
    }

    private setupPeerConnection() {
        this.pc.ontrack = (event: RTCTrackEvent) => {
            if (event.track.kind === 'video') {
                //this.config.onVideoReceived(new MediaStream([event.track]));
            }
        };

        this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                this.ws.send(JSON.stringify({
                    message: "icecandidate",
                    candidate: event.candidate
                }));
            }
        };
    }

    private setupDataChannel() {
        this.dc = this.pc.createDataChannel('myDataChannel');
        this.dc.binaryType = 'arraybuffer';

        this.dc.onmessage = (event: MessageEvent) => {
            const message = JSON.parse(event.data);
            console.log('Data channel message received: ', message.type);

            switch (message.type) {
                case 'remove_editor':
                    this.removeEditor(message.number);
                    break;
                case 'hide_editors':
                    this.hideEditors();
                    break;
                case 'show_editors':
                    this.showEditors();
                    break;
                case 'add_editor':
                    this.addImageEditor(message.number, message.chunk, false);
                    break;
                case 'set_selected_editor':
                    this.doSelectEditor(message.number);
                    break;
                case 'file':
                    this.handleFile(message);
                    break;
                default:
                    throw new Error('Unknown message type');
            }

            if (this.config.onDataChannelMessage) {
                this.config.onDataChannelMessage(message);
            }
        };

        this.dc.onopen = () => console.log('Data channel opened');
        this.dc.onclose = () => console.log('Data channel closed');
    }

    private handleOffer(sdp: RTCSessionDescriptionInit, mySessionId: string, targetSessionId: string) {
        const offerOptions: RTCOfferOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
        }
        this.pc.setRemoteDescription(new RTCSessionDescription(sdp))
            .then(() => this.pc.createAnswer(offerOptions))
            .then(answer => {
                this.pc.setLocalDescription(answer);
                return answer;
            })
            .then(answer => {
                this.ws.send(JSON.stringify({
                    message: "answer",
                    mySessionId: mySessionId,
                    targetSessionId: targetSessionId,
                    sdp: answer
                }));
            });
    }

    private handleAnswer(sdp: RTCSessionDescriptionInit) {
        this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }

    private handleIceCandidate(candidate: RTCIceCandidateInit) {
        this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    public sendMessage(message: any) {
        if (this.dc && this.dc.readyState === "open") {
            this.dc.send(JSON.stringify(message));
        } else {
            throw new Error('Data channel not open');
        }
    }

    public close() {
        this.ws.close();
        this.pc.close();
    }

    public getSessionId(): string {
        return this.sessionId;
    }
}
