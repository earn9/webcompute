
function send() {
	window.event.preventDefault();
	output.textContent = '';
	var outputType = this.vmoutputtype.value;
	var outputWidth = parseInt(this.vmoutputwidth.value);
	var outputHeight = parseInt(this.vmoutputheight.value);
	var outputAnimated = this.vmoutputanimated.checked;
	var outputTilesX = parseInt(this.vmoutputtilesx.value || 1);
	var outputTilesY = parseInt(this.vmoutputtilesy.value || 1);
	if (outputAnimated) {
		const canvas = document.createElement('canvas');
		canvas.width = outputWidth * outputTilesX;
		canvas.height = outputHeight * outputTilesY;
		document.getElementById('output').append(canvas);
	}
	Cluster.run({
		name: this.vmname.value,
		nodes: this.vmnodes.value,
		source: window.vmsrcEditor.getValue(),
		params: this.vmparams.value.replace(/\s+/, '').split(","),
		outputLength: parseInt(this.vmoutputsize.value),
		async onResponse(res, input, runJob, jobIdx) {
			var tileCount = (outputTilesX * outputTilesY);
			var frame = Math.floor(jobIdx / tileCount);
			var tileIdx = jobIdx - (frame * tileCount);
			var y = Math.floor(tileIdx / outputTilesX);
			var x = tileIdx - (y * outputTilesX);
			var output = null;
			if (!outputAnimated) {
				output = document.createElement('span');
				document.getElementById('output').append(output);
			}
			const arrayBuffer = await Cluster.responseToArrayBuffer(res, (header) => {
				if (!outputAnimated) {
					output.textContent = JSON.stringify(header);
				}
			});
			if (arrayBuffer.header.type === 'error') {
				if (!outputAnimated) {
					output.remove();
				}
				runJob(input);
			} else {
				processResponse(arrayBuffer, output, outputType, outputWidth, outputHeight, outputAnimated, x, y, frame, outputTilesX, outputTilesY);
			}
		}
	});
}


function processResponse(arrayBuffer, output, outputType, outputWidth, outputHeight, outputAnimated, x, y, frame, outputTilesX, outputTilesY) {
	const resultHeader = arrayBuffer.header;
	var targetCanvas = outputAnimated && document.querySelector('#output canvas');
	if (resultHeader.type === 'image/ppm' || outputType === 'ppm') {
		targetCanvas = ppmToCanvas(new Uint8Array(arrayBuffer), targetCanvas);
	} else {
		var resultArray = null;
		var outputFunc = (txt) => document.createTextNode(txt);

		if (outputType === 'uint8gray' || outputType === 'uint8rgba') {
			resultArray = new Uint8Array(arrayBuffer);
			outputFunc = outputType === 'uint8gray' ? rawGrayUint8ToCanvas : rawRGBAUint8ToCanvas;

		} else if (outputType === 'float32gray' || outputType === 'float32rgba') {
			resultArray = new Float32Array(arrayBuffer);
			outputFunc = outputType === 'float32gray' ? rawGrayFloat32ToCanvas : rawRGBAFloat32ToCanvas;

		} else {
			resultArray = String.fromCharCode.apply(null, new Uint8Array(arrayBuffer));

		}

		if (outputTilesX > 1 || outputTilesY > 1) {
			if (!window.tileCanvas) {
				window.tileCanvas = document.createElement('canvas');
				window.tileCanvas.width = outputWidth;
				window.tileCanvas.height = outputHeight;
			}
			outputFunc(resultArray, outputWidth, outputHeight, tileCanvas);
			var ctx = targetCanvas.getContext('2d');
			ctx.globalCompositeOperator = 'copy';
			ctx.drawImage(tileCanvas, x * tileCanvas.width, y * tileCanvas.height);

		} else {
			targetCanvas = outputFunc(resultArray, outputWidth, outputHeight, targetCanvas);
		}
	}
	if (!outputAnimated) {
		output.append(targetCanvas);
	}
}

window.vmsrcEditor = null;
require.config({ paths: { 'vs': 'monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], function () {
	fetch('examples/mandel.ispc').then(res => res.text()).then(text => {
		window.vmsrcEditor = monaco.editor.create(document.getElementById('container'), {
			value: text,
			language: 'c'
		});
	});
});

window.onresize = function () {
	window.vmsrcEditor.layout();
};

var addNodes = function (nodeList) {
	var nodes = JSON.parse(document.getElementById('vmnodes').value || '[]');
	var hosts = {}
	nodes.map(n => hosts[n.url] = true);
	newNodes = nodeList.filter(n => !hosts[n.url]);
	if (newNodes.length > 0) {
		nodes = nodes.concat(newNodes);
		document.getElementById('vmnodes').value = JSON.stringify(nodes);
		updateVMNodes();
	}
}

var addNode = function () {
	if (window.event) {
		window.event.preventDefault();
	}

	var host = window.addnode.value;
	var url = 'http://' + host + ':7172';
	fetch(url + '/nodes').then(res => res.json()).then(addNodes);
};

var updateVMNodes = function () {
	var nodes = JSON.parse(document.getElementById('vmnodes').value);
	var nodeList = document.getElementById('vmnodelist');
	nodeList.innerHTML = '';
	nodes.forEach(n => {
		var el = document.createElement('span');
		el.textContent = n.url.split(/:(\/\/)?/)[2];
		nodeList.append(el);
	});
};

fetch('/nodes').then(res => res.json()).then(addNodes);
