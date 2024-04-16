# Docker-Ruby-Rubocop
### Liniting as per your convenience 

Docker-Rubocop is a VSCode etension that lets you lint ruby files using rubocop on system and rubocop running inside docker containers.

## Features
___
- Execute Rubocop inside docker or in the host machine
- Get Lint output for files with large number of lines


## A Note of Gratitude
___
This extension is created by forking a good plugin name ruby-rubocop create by the man [misogi](https://github.com/misogi?tab=overview). Misogi have  have provided the ruby commuity with a good linting plugin for years. His code heped me a lot while building this plugin. So, **a big thanks to the friend I have never met** 🤝🏽.

## Installation and Setup
___
1. Go to Vscode Extensions Tab
2. Search for Docker-Ruby-Rubocop
3. Click on the extension made by s035 and install.

Open Extension's Setting and follow the below steps for respective modes.
#### Setup for using rubocop on docker (Docker Mode)
- check the "useDocker" checkbox.
- check the "disableEmptyFileCop" checkbox (if you enable this, you will receive an Lint/EmptyfileCop offence when linitng the files which are not present inside the docker container.)
- If you have an rubocop config file inside the docker, please specify the rubocop config file path inside the docker container.
#### Setup for using rubocop on system (Normal Mode)
-  Uncheck the useDocker checkbox.
-  Uncheck the disableEmptyFileCop.
-  Provide the path where rubocop is available in the Execution Path Input Box.
-  Provide the path for rubocop config file on system, if rubocop config file is available.

If you want rubocop to be ran on every save, check the execute on save checkbox.

### Issues
___
If you face any issues or problemswhen using the extension, please feel free to create an issue.