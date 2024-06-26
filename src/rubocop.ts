import { RubocopOutput, RubocopFile, RubocopOffense } from './rubocopOutput';
import { TaskQueue, Task } from './taskQueue';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, RubocopConfig } from './configuration';
import { ExecFileException } from 'child_process';

export class RubocopAutocorrectProvider
  implements vscode.DocumentFormattingEditProvider
{
  public provideDocumentFormattingEdits(
    document: vscode.TextDocument
  ): vscode.TextEdit[] {
    const config = getConfig();
    try {
      const args = [
        ...getCommandArguments(document.fileName),
        '--auto-correct',
      ];
      const options = {
        cwd: getCurrentPath(document.uri),
        input: document.getText(),
      };
      let stdout;
      if (config.useBundler) {
        stdout = cp.execSync(`${config.command} ${args.join(' ')}`, options);
      } else {
        stdout = cp.execFileSync(config.command, args, options);
      }

      return this.onSuccess(document, stdout);
    } catch (e) {
      // if there are still some offences not fixed RuboCop will return status 1
      if (e.status !== 1) {
        vscode.window.showWarningMessage(
          'An error occurred during auto-correction'
        );
        console.log(e);
        return [];
      } else {
        return this.onSuccess(document, e.stdout);
      }
    }
  }

  // Output of auto-correction looks like this:
  //
  // {"metadata": ... {"offense_count":5,"target_file_count":1,"inspected_file_count":1}}====================
  // def a
  //   3
  // end
  //
  // So we need to parse out the actual auto-corrected ruby
  private onSuccess(document: vscode.TextDocument, stdout: Buffer) {
    const stringOut = stdout.toString();
    const autoCorrection = stringOut.match(
      /^.*\n====================(?:\n|\r\n)([.\s\S]*)/m
    );
    if (!autoCorrection) {
      throw new Error(`Error parsing auto-correction from CLI: ${stringOut}`);
    }
    return [
      new vscode.TextEdit(this.getFullRange(document), autoCorrection.pop()),
    ];
  }

  private getFullRange(document: vscode.TextDocument): vscode.Range {
    return new vscode.Range(
      new vscode.Position(0, 0),
      document.lineAt(document.lineCount - 1).range.end
    );
  }
}

function isFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file';
}

function getCurrentPath(fileUri: vscode.Uri): string {
  const wsfolder = vscode.workspace.getWorkspaceFolder(fileUri);
  return (wsfolder && wsfolder.uri.fsPath) || path.dirname(fileUri.fsPath);
}

// extract argument to an array
function getCommandArguments(fileName: string): string[] {
  let commandArguments = ['--stdin',fileName,'--force-exclusion'];
  const extensionConfig = getConfig();
  if (extensionConfig.configFilePath !== '') {
    const prefix_command = extensionConfig.useDocker ? `exec ${extensionConfig.dockerContainer}` : '';
    let fileExistenceTest;
    if(extensionConfig.useDocker) {
      fileExistenceTest = cp.spawnSync('docker',`${prefix_command} test -f ${extensionConfig.configFilePath} && echo 'exists'`.split(' '), {shell: true})
    }
    else {
      fileExistenceTest = cp.spawnSync('test', `-f ${extensionConfig.configFilePath} && echo 'exists'`.split(' '), { shell:true })
    }
    if(!fileExistenceTest.stdout?.toString().includes('exists')) {
      vscode.window.showWarningMessage(
        `${extensionConfig.configFilePath} file does not exist. Rubocop will run with default config`
      );
    }
  }
  if(extensionConfig.disableEmptyFileCop) {
    commandArguments = commandArguments.concat('--except', 'Lint/EmptyFile')
  }
  return commandArguments;
}

export class Rubocop {
  public config: RubocopConfig;
  private diag: vscode.DiagnosticCollection;
  private additionalArguments: string[];
  private taskQueue: TaskQueue = new TaskQueue();

  constructor(
    diagnostics: vscode.DiagnosticCollection,
    additionalArguments: string[] = []
  ) {
    this.diag = diagnostics;
    this.additionalArguments = additionalArguments;
    this.config = getConfig();
  }

  public execute(document: vscode.TextDocument, onComplete?: () => void): void {
    if (
      (document.languageId !== 'gemfile' && document.languageId !== 'ruby') ||
      document.isUntitled ||
      !isFileUri(document.uri)
    ) {
      // git diff has ruby-mode. but it is Untitled file.
      return;
    }

    const fileName = document.fileName;
    const uri = document.uri;

    const onDidExec = (error: Error, stdout: string, stderr: string) => {
      this.reportError(error, stderr);
      const rubocop = this.parse(stdout);
      if (rubocop === undefined || rubocop === null) {
        return;
      }

      this.diag.delete(uri);

      const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
      rubocop.files.forEach((file: RubocopFile) => {
        const diagnostics = [];
        file.offenses.forEach((offence: RubocopOffense) => {
          const loc = offence.location;
          const range = new vscode.Range(
            loc.line - 1,
            loc.column - 1,
            loc.line - 1,
            loc.length + loc.column - 1
          );
          const sev = this.severity(offence.severity);
          const message = `${offence.message} (${offence.severity}:${offence.cop_name})`;
          const diagnostic = new vscode.Diagnostic(range, message, sev);
          diagnostics.push(diagnostic);
        });
        entries.push([uri, diagnostics]);
      });

      this.diag.set(entries);
    };

    const jsonOutputFormat = ['--format', 'json'];
    const args = getCommandArguments(fileName)
      .concat(this.additionalArguments)
      .concat(jsonOutputFormat);

    const task = new Task(uri, (token) => {
      this.executeRubocop(
        args,
        getCurrentPath(uri),
        document.getText(),
        (error, stdout, stderr) => {
          if (token.isCanceled) {
            return;
          }
          onDidExec(error, stdout, stderr);
          token.finished();
          if (onComplete) {
            onComplete();
          }
        }
      );
      return () => console.log('call canceled');
    });
    this.taskQueue.enqueue(task);
  }

  public get isOnSave(): boolean {
    return this.config.onSave;
  }

  public clear(document: vscode.TextDocument): void {
    const uri = document.uri;
    if (isFileUri(uri)) {
      this.taskQueue.cancel(uri);
      this.diag.delete(uri);
    }
  }

  // execute rubocop
  private executeRubocop(
    args: string[],
    cwd: string,
    fileContents: string,
    cb: (err: Error, stdout: string, stderr: string) => void
  ): void {
    const options = {maxBuffer: 1073741824, input: fileContents}  // 1073741824 bytes = 1 Megabyte
    let command, spawnArgs;
    if(this.config.useDocker) {
      command = 'docker'
      spawnArgs = this.config.command.replace('docker ', '').split(' ').concat(args)
    }
    else if(this.config.useBundler) {
      command = 'bundle';
      spawnArgs = this.config.command.replace('bundle ', '').split(' ').concat(args)
      options['cwd'] = cwd
    }
    else {
      command = this.config.command;
      spawnArgs = args;
    }
    const child = cp.spawnSync(command, spawnArgs, options);
    cb(child.error,child.stdout?.toString(),child.stderr?.toString())
  }

  // parse rubocop(JSON) output
  private parse(output: string): RubocopOutput | null {
    let rubocop: RubocopOutput;
    if (output.length < 1) {
      const message = `command ${this.config.command} returns empty output! please check configuration.`;
      vscode.window.showWarningMessage(message);

      return null;
    }

    try {
      rubocop = JSON.parse(output);
    } catch (e) {
      if (e instanceof SyntaxError) {
        const regex = /[\r\n \t]/g;
        const message = output.replace(regex, ' ');
        const errorMessage = `Error on parsing output (It might non-JSON output) : "${message}"`;
        vscode.window.showWarningMessage(errorMessage);

        return null;
      }
    }

    return rubocop;
  }

  // checking rubocop output has error
  private reportError(error: ExecFileException, stderr: string): boolean {
    const errorOutput = stderr.toString();
    if (error && error.code === 'ENOENT') {
      vscode.window.showWarningMessage(
        `${this.config.command} is not executable`
      );
      return true;
    } else if (error && error.code === 127) {
      vscode.window.showWarningMessage(stderr);
      return true;
    } else if (errorOutput.length > 0 && !this.config.suppressRubocopWarnings) {
      vscode.window.showWarningMessage(stderr);
      return true;
    }

    return false;
  }

  private severity(sev: string): vscode.DiagnosticSeverity {
    switch (sev) {
      case 'refactor':
        return vscode.DiagnosticSeverity.Hint;
      case 'convention':
      case 'info':
        return vscode.DiagnosticSeverity.Information;
      case 'warning':
        return vscode.DiagnosticSeverity.Warning;
      case 'error':
        return vscode.DiagnosticSeverity.Error;
      case 'fatal':
        return vscode.DiagnosticSeverity.Error;
      default:
        return vscode.DiagnosticSeverity.Error;
    }
  }
}
