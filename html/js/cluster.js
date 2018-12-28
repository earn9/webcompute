class Cluster {

	constructor(nodes) {
		this.buildNodes = nodes.filter(n => n.info.canBuild);
		this.nodes = nodes;
		this.availableNodes = {};
		this.availableNodes.ISPC = nodes.slice();
		this.availableNodes.SPIRV = [];
		nodes.forEach(n => {
			(n.info.vulkanDevices || []).forEach((vd, idx) => {
				var vulkanNode = { ...n, vulkanDeviceIndex: idx, sockets: {} };
				this.availableNodes.SPIRV.push(vulkanNode);
			});
			n.sockets = {};
			this.availableNodes.SPIRV.push(n);
		});
		this.workQueue = { ISPC: [], SPIRV: [] };
	}

	processWorkQueue(nodeType = 'ISPC') {
		if (this.workQueue[nodeType].length > 0 && this.availableNodes[nodeType].length > 0) {
			var node = this.availableNodes[nodeType].shift();
			while (node && node.disabled) {
				node = this.availableNodes[nodeType].shift();
			}
			if (!node) {
				return;
			}
			var callback = this.workQueue[nodeType].shift();
			var fired = false;
			var doNext = () => {
				if (!fired) {
					fired = true;
					this.availableNodes[nodeType].push(node);
					this.processWorkQueue(nodeType);
				}
			};
			callback(node, doNext);
		}
	}

	getNode(callback, nodeType = 'ISPC') {
		this.workQueue[nodeType].push(callback);
		this.processWorkQueue(nodeType);
	}

	async build(node, name, source, language, vulkanDeviceIndex, inputLength, outputLength) {
		var hash = await sha256(JSON.stringify({ language, vulkanDeviceIndex, inputLength, outputLength, source }));
		if (node.info.canBuild || (vulkanDeviceIndex != null && language === 'glsl')) {
			return { blob: new Blob([source]), isBinary: false, hash };
		} else {
			const vmSuffix = '/build/' + name;
			const args = {
				platform: node.info.platform,
				language: language,
				vulkanDeviceIndex: vulkanDeviceIndex,
				arch: node.info.arch,
				target: node.info.target,
				addressing: 32
			};
			var key = await sha256(JSON.stringify({ ...args, source: source }));
			if (!Cluster.buildCache[key]) {
				Cluster.buildCache[key] = new Promise(async (resolve, reject) => {
					const buildNode = this.buildNodes.find(bn => {
						return (
							bn.info.platform === args.platform &&
							(bn.info.canCrossCompile || bn.info.arch === args.arch)
						);
					});
					if (!buildNode) {
						resolve(false);
					}
					const bin = JSON.stringify(source);
					const body = new Blob([JSON.stringify(args), '\n', bin]);
					const url = buildNode.url + vmSuffix;
					const res = await fetch(url, { method: 'POST', body });
					const blob = await Cluster.responseToBlob(res);
					resolve({ blob, isBinary: true, hash });
				});
			}
			return Cluster.buildCache[key];
		}
	}

	disableNode(node) {
		node.disabled = true;
	}

	static run(options) {
		var {
			nodes,
			name,
			language,
			source,
			params,
			outputLength,
			onResponse,
			workgroups,
			useHTTP
		} = options;
		var green = '';
		var cluster = this.parse(nodes);
		var inputs = this.expandParams(params);
		var vmSuffix = '/new' + green + '/' + name;
		var runJob = (jobInput, jobIndex) => {
			cluster.getNode(async (node, next) => {
				const inputLength = jobInput.length * 4;
				const program = await cluster.build(node, name, source, language, node.vulkanDeviceIndex, inputLength, outputLength);
				if (!program) {
					cluster.disableNode(node);
					return runJob(jobInput);
				}
				const bin = program.blob;
				const url = node.url + vmSuffix;

				if (!useHTTP && language === 'glsl') {
					const socket = await this.getNodeSocket(node, url, name, language, workgroups, program, inputLength, outputLength);
					socket.queue.push([onResponse, jobInput, runJob, jobIndex, next]);
					socket.send(new Float32Array(jobInput).buffer);
				} else {
					let jobIdx = jobIndex;
					// do a normal HTTP request
					const args = { input: jobInput, outputLength, language, workgroups, vulkanDeviceIndex: node.vulkanDeviceIndex, binary: program.isBinary };
					const body = new Blob([JSON.stringify(args), '\n', bin]);
					var res;
					try {
						res = await fetch(url, { method: 'POST', body });
					} catch (e) {
						cluster.disableNode(node);
						runJob(jobInput);
					}
					return onResponse(res, jobInput, runJob, jobIdx);
				}
			}, language === 'glsl' ? 'SPIRV' : 'ISPC');
		};
		inputs.forEach(runJob);
		return cluster;
	}

	static async getNodeSocket(node, url, name, language, workgroups, program, inputLength, outputLength) {
		if (!node.sockets[program.hash]) {
			node.sockets[program.hash] = new Promise((resolve, reject) => {
				const bin = program.blob;
				const workQueue = [];
				const socket = new WebSocket(url.replace('http', 'ws'));
				socket.programArgs = {
					name,
					inputLength,
					outputLength,
					language,
					workgroups,
					vulkanDeviceIndex: node.vulkanDeviceIndex,
					binary: program.isBinary
				};
				socket.program = program;
				socket.queue = workQueue;
				socket.blocks = [];
				socket.kernelArgs = [];
				socket.gotHeader = false;
				socket.receivedBytes = 0;
				socket.binaryType = 'arraybuffer';
				socket.onerror = reject;
				socket.started = false;
				socket.processQueue = function () {
					if (this.queue.length > 0) {
						var [[onHeader, onData, onBody], input, runJob, jobIdx, next] = this.queue.shift();
						this.onHeader = onHeader;
						this.onBody = onBody;
						this.onData = onData;
						this.kernelArgs = [input, runJob, jobIdx, next];
						this.onHeader(this.header, ...this.kernelArgs);
						if (this.blocks.length > 0) {
							this.blocks.forEach(b => this.onData(b, ...this.kernelArgs));
						}
					}
				};
				socket.onmessage = function (ev) {
					if (ev.data === 'READY.') {
						// Connection init
						// Send kernel
						var blob = new Blob([JSON.stringify(this.programArgs), '\n', bin]);
						var fr = new FileReader();
						fr.onload = () => {
							this.send(fr.result);
						};
						fr.readAsArrayBuffer(blob);
					} else if (!this.gotHeader) {
						// Got kernel process header frame
						this.gotHeader = true;
						this.header = JSON.parse(ev.data);
						console.log("header", this.header);
						resolve(this);
					} else {
						if (!this.started) {
							this.started = true;
							this.processQueue();
						}
						this.receivedBytes += ev.data.byteLength;
						// console.log(receivedBytes);
						if (this.receivedBytes >= this.programArgs.outputLength) {
							var offset = ev.data.byteLength - (this.receivedBytes - this.programArgs.outputLength);
							var lastSlice = ev.data.slice(0, offset);
							this.onData(lastSlice, ...this.kernelArgs);
							this.blocks.push(lastSlice);
							// console.log("got full response", node.vulkanDeviceIndex, outputLength, receivedBytes);
							var ab = this.blocks[0];
							if (this.blocks.length > 1) {
								ab = new ArrayBuffer(this.blocks.reduce(((s,b) => s + b.byteLength), 0));
								var u8 = new Uint8Array(ab);
								this.blocks.reduce((offset, b) => {
									u8.set(new Uint8Array(b), offset);
									return offset + b.byteLength
								}, 0);
							}
							this.handleResult(ab, offset, ev)
						} else {
							this.onData(ev.data, ...this.kernelArgs);
							this.blocks.push(ev.data);
						}
					}
				};

				socket.handleResult = function(result, offset, ev) {
					result.header = this.header;
					if (this.onBody) {
						this.onBody(result, ...this.kernelArgs);
					} else {
						this.result = result;
					}
					this.onHeader = this.onBody = null;
					this.onData = () => { };
					this.blocks = [];
					this.receivedBytes -= this.programArgs.outputLength;
					if (offset < ev.data.length) {
						var firstSlice = ev.data.slice(offset);
						this.blocks.push(firstSlice);
						this.processQueue();
					} else {
						this.started = false;
					}
				};
			});
		}
		return node.sockets[program.hash];
	}

	static parse(nodeString) {
		return new Cluster(JSON.parse(nodeString));
	}

	static expandParam(param) {
		if ((/\.\./).test(param)) {
			const [startStr, endStr, stepStr] = param.split(/\.\.\.?|:/);
			const step = stepStr ? Math.abs(parseFloat(stepStr)) : 1;
			const start = parseFloat(startStr);
			const end = parseFloat(endStr);
			if (isNaN(start + end + step)) {
				throw new Error("Invalid range param");
			}
			var a = [];
			if (start < end) {
				for (var x = start; x < end; x += step) {
					a.push(x);
				}
			} else {
				for (var x = start; x > end; x -= step) {
					a.push(x);
				}
			}
			if (!(/\.\.\./).test(param)) {
				a.push(parseFloat(end));
			}
			return a;
		} else {
			return [parseFloat(param)];
		}
	}

	static expandParams(params) {
		if (params.length === 0) {
			return [];
		}
		var expanded = [];
		var colParams = params.map(this.expandParam);
		var indices = colParams.map(() => 0);
		while (true) {
			var arr = [];
			expanded.push(arr);
			for (var i = 0; i < indices.length; i++) {
				arr.push(colParams[i][indices[i]]);
			}
			indices[0]++;
			for (var i = 0; i < indices.length - 1; i++) {
				if (indices[i] === colParams[i].length) {
					indices[i] = 0;
					indices[i + 1]++;
				} else {
					break;
				}
			}
			if (indices[i] === colParams[i].length) {
				break;
			}
		}
		return expanded;
	}

	static responseToBlob(response, onheader, ondata) {
		return new Promise((resolve, reject) => {
			const reader = response.body.getReader();
			const stream = new ReadableStream({
				start(controller) {
					var decoder = new TextDecoder('utf-8');
					var typeDecoder = new TextDecoder('utf-8');
					var gotHeader = false;
					var gotType = false;
					var resultBuffer = [];
					var resultHeader = {};
					var typeString = '';
					var headerString = '';
					function push() {
						reader.read().then(({ done, value }) => {
							if (done) {
								controller.close();
								var resultBlob = new Blob(resultBuffer, { type: resultHeader.type });
								resultBlob.header = resultHeader;
								resolve(resultBlob);
								return;
							}
							if (!gotHeader) {
								var endOfHeader = value.indexOf(10);
								var headerSlice = value.slice(0, endOfHeader);
								headerString += decoder.decode(headerSlice, { stream: true });
								if (endOfHeader > -1) {
									resultHeader = JSON.parse(headerString);
									gotHeader = true;
									if (onheader) {
										onheader(resultHeader);
									}
									value = value.slice(endOfHeader + 1);
								}
							}
							if (!gotType) {
								var endOfType = value.indexOf(10);
								var typeSlice = value.slice(0, endOfType);
								typeString += typeDecoder.decode(typeSlice, { stream: true });
								if (endOfType > -1) {
									resultHeader.type = typeString;
									gotType = true;
									if (onheader) {
										onheader(resultHeader);
									}
									value = value.slice(endOfType + 1);
								}
							}
							if (gotType) {
								resultBuffer.push(value);
								if (ondata) {
									ondata(value);
								}
							}
							push();
						});
					};

					push();
				},

				error: reject
			});

			return new Response(stream, { headers: { "Content-Type": "text/html" } });
		});
	}

	static responseToArrayBuffer(response, onheader, ondata) {
		return new Promise(async (resolve, reject) => {
			const resultBlob = await this.responseToBlob(response, onheader, ondata);
			var fileReader = new FileReader();
			fileReader.onload = function (event) {
				const arrayBuffer = event.target.result;
				arrayBuffer.header = resultBlob.header;
				resolve(arrayBuffer);
			};
			fileReader.onerror = reject;
			fileReader.readAsArrayBuffer(resultBlob);
		});
	}
}

Cluster.buildCache = {};
