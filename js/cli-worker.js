"use strict"

var wasmDir = "https://vgmstream.org/web/"

// messageEvent 関数の修正部分 (既存の switch 文を置き換える)

async function messageEvent(data){
	var input = data.content
	var output
	var error
	try{
		switch(data.subject){
			case "convertDir":
				output = await convertDir(...input)
				break
			case "convertFile":
				output = await convertFile(...input)
				break
			case "vgmstream":
				output = vgmstream(...input)
				break
			case "writeFile":
				output = writeFile(...input)
				break
			case "readFile":
				output = readFile(...input)
				break
			case "deleteFile":
				output = deleteFile(...input)
				break
			// ⭐ 新しいコマンドを追加
			case "extractAllStreams": 
				output = await extractAllStreams(...input)
				break
			default:
				error = new Error("Unknown message subject")
				break
		}
	}catch(e){
		error = cleanError(e)
	}
	return postMessage({
		symbol: data.symbol,
		subject: data.subject,
		error: error,
		content: output
	})
}

function setupDir(dir, callback){
	var wfs = "/workerfs"
	FS.mkdir(wfs)
	FS.mount(WORKERFS, {
		files: dir
	}, wfs)
	FS.chdir(wfs)
	try{
		var output = callback()
	}finally{
		FS.chdir("/")
		FS.unmount(wfs)
		FS.rmdir(wfs)
	}
	return output
}

async function convertDir(dir, inputFilename, arrayBuffer){
	var outputFilename = "/" + Math.random() + "output.wav"
	
	var output = setupDir(dir, () => vgmstream("-I", "-o", outputFilename, "-i", inputFilename))
	
	return getOutput(output, inputFilename, outputFilename, arrayBuffer)
}

async function convertFile(data, inputFilename, arrayBuffer){
	var outputFilename = "/" + Math.random() + "output.wav"
	
	writeFile(inputFilename, data)
	var output = vgmstream("-I", "-o", outputFilename, "-i", inputFilename)
	deleteFile(inputFilename)
	
	return getOutput(output, inputFilename, outputFilename, arrayBuffer)
}

function getOutput(output, inputFilename, outputFilename, arrayBuffer){
	if(output.error){
		deleteFile(outputFilename)
		var error = output.error
		error.stdout = output.stdout
		error.stderr = output.stderr
		throw error
	}
	var wavdata = readFile(outputFilename)
	if(!wavdata){
		var error = new Error("vgmstream: Unsupported file")
		error.stdout = output.stdout
		error.stderr = output.stderr
		throw error
	}
	deleteFile(outputFilename)
	output.inputFilename = inputFilename
	output.outputFilename = inputFilename + ".wav"
	if(arrayBuffer){
		output.arrayBuffer = wavdata.buffer
	}else{
		output.url = URL.createObjectURL(new Blob([wavdata], {
			type: "audio/x-wav"
		}))
	}
	return output
}

function writeFile(name, data){
	var stream = FS.open(name, "w+")
	FS.write(stream, data, 0, data.length, 0)
	FS.close(stream)
}

function readFile(name){
	try{
		var file = FS.open(name, "r")
	}catch(e){
		return null
	}
	var data = new Uint8Array(file.node.usedBytes)
	FS.read(file, data, 0, file.node.usedBytes, 0)
	FS.close(file)
	return data
}

function deleteFile(name){
	try{
		FS.unlink(name)
	}catch(e){}
}

function vgmstream(...args){
	stdoutBuffer = ""
	stderrBuffer = ""
	var error
	try{
		callMain(args)
	}catch(e){
		e.type = "wasm"
		throw e
	}
	var output = {
		stdout: stdoutBuffer,
		stderr: stderrBuffer
	}
	stdoutBuffer = ""
	stderrBuffer = ""
	if(error){
		output.error = error
	}
	return output
}

function errorLoading(file){
	postMessage({
		subject: "load",
		error: "Error loading " + file
	})
}

async function loadCli(){
	var wasmBlobUrl
	wasmUri = name => wasmDir + name
	try{
		await fetch(wasmDir + "version")
	}catch(e){}
	var cliJs
	try{
		cliJs = await (await fetch(wasmDir + "vgmstream-cli.js")).text()
	}catch(e){}
	if(!cliJs){
		return errorLoading("vgmstream-cli.js")
	}
	try{
		eval.bind()(cliJs)
	}catch(e){
		console.error(e)
		return errorLoading("vgmstream-cli.js")
	}
	try{
		await new Promise((resolve, reject) => {
			Module["onRuntimeInitialized"] = resolve
			Module["onAbort"] = reject
		})
	}catch(e){
		console.error(e)
		return errorLoading("vgmstream-cli.wasm")
	}
	if(wasmBlobUrl){
		URL.revokeObjectURL(wasmBlobUrl)
	}
	return postMessage({
		subject: "load"
	})
}

function cleanError(error){
	var output = {
		name: error.name,
		message: error.message,
		stack: error.stack
	}
	for(var i in error){
		output[i] = error[i]
	}
	return output
}

var wasmUri
var stdoutBuffer = ""
var stderrBuffer = ""
var Module = {
	preRun: () => {
		FS.init(undefined, code => {
			if(code !== null){
				stdoutBuffer += String.fromCharCode(code)
			}
		}, code => {
			if(code !== null){
				stderrBuffer += String.fromCharCode(code)
			}
		})
	},
	noInitialRun: true,
	locateFile: name => wasmUri(name)
}
addEventListener("message", event => messageEvent(event.data))
// ----------------------------------------------------
// ⭐ ファイル末尾に追加する新しい関数
// ----------------------------------------------------

async function extractAllStreams(dir, inputFilename){
	// 一時ディレクトリを作成
	var tempDir = "/temp_out"
	FS.mkdir(tempDir)
	
	// vgmstreamを実行し、全てのストリームを tempDir 内に出力させる
	// -m (multi-file output) -o "%o/%n#%s.wav" (出力フォーマット)
	var output = setupDir(dir, () => vgmstream(
		"-m", 
		"-o", tempDir + "/%n#%s.wav", 
		"-i", inputFilename
	))

	if(output.error){
		// エラー処理
		var error = output.error
		error.stdout = output.stdout
		error.stderr = output.stderr
		// テンポラリディレクトリをクリーンアップ
		FS.rmdir(tempDir)
		throw error
	}
	
	var allStreamFiles = []
	
	// tempDir内の全てのファイル名を取得
	var filesInTemp = FS.readdir(tempDir)
	
	for(var i = 0; i < filesInTemp.length; i++){
		var name = filesInTemp[i]
		// . や .. 以外のファイル（抽出されたWAVファイル）のみを処理
		if(name !== "." && name !== ".."){
			var fullPath = tempDir + "/" + name
			var wavData = readFile(fullPath)
			if(wavData){
				allStreamFiles.push({
					name: name, // 例: on_memory_bank_bundled#0.wav
					buffer: wavData.buffer // ArrayBuffer形式で返す
				})
			}
			deleteFile(fullPath) // 抽出後、ファイルを削除してクリーンアップ
		}
	}
	
	// テンポラリディレクトリをクリーンアップ
	FS.rmdir(tempDir)
	
	// 抽出された全てのストリーム（ArrayBufferと名前の配列）を返す
	return allStreamFiles
}
loadCli()
