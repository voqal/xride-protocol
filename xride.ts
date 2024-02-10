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

type EditorStateChangeListener = (editor: Editor) => void;

export class Editor {
    private visible: boolean = true;
    private selected: boolean = false;
    private content: Array<IXRideText>;
    private listeners: EditorStateChangeListener[] = [];

    constructor(content: Array<IXRideText>) {
        this.content = content;
    }

    setContent(content: Array<IXRideText>) {
        this.content = content;
        this.notifyListeners();
    }

    getContent(): Array<IXRideText> {
        return this.content;
    }

    addListener(listener: EditorStateChangeListener) {
        this.listeners.push(listener);
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        this.notifyListeners();
    }

    isVisible(): boolean {
        return this.visible;
    }

    setSelected(selected: boolean) {
        this.selected = selected;
        this.notifyListeners();
    }

    isSelected(): boolean {
        return this.selected;
    }

    private notifyListeners() {
        this.listeners.forEach(listener => listener(this));
    }
}

export class XRideProtocol {
    private ws: WebSocket;
    private pc: RTCPeerConnection;
    private config: IXRideConfig;
    private dc?: RTCDataChannel;
    private localStream: MediaStream[] = []
    // private localAudio: HTMLAudioElement = document.createElement('audio')
    private receivedChunkMap = new Map<number, any[]>()
    private editors: Map<number, Editor> = new Map();
    private transmitAudio: boolean = true;
    private sessionId: string = "";

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
                    // this.localAudio.srcObject = stream
                    // this.localAudio.autoplay = true
                    // this.localAudio.addEventListener('loadedmetadata', () => {
                    //     console.log('audio loaded')
                    // });
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
                    this.addEditor(message.number, message.chunk, false);
                    break;
                case 'set_selected_editor':
                    this.setSelectedEditor(message.number);
                    break;
                case 'file':
                    this.handleFile(message);
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
        this.editors.delete(index)
    }

    private addEditor(index: number, content: Array<IXRideText>, visible: boolean) {
        console.log("Adding editor: ", index)
        const editor = new Editor(content);
        editor.setVisible(visible);
        this.editors.set(index, editor);
    }

    private setSelectedEditor(index: number) {
        console.log("Setting selected editor: ", index)
        this.editors.forEach((editor, key) => {
            editor.setSelected(key === index);
        });
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

    onEditorSelected(currentSelected: number, previousSelected: number) {
        const json = {
            "number": currentSelected,
            "previous": previousSelected,
            "type": "selected_monitor"
        }
        this.sendMessage(json)
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
            const data = JSON.parse(event.data);
            if (this.config.onDataChannelMessage) {
                this.config.onDataChannelMessage(data);
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
}
