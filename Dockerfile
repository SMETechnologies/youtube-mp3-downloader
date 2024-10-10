# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Install ffmpeg
RUN apk update && apk add ffmpeg

# Set the working directory
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files to install dependencies
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the entire application directory
COPY . .

# Set the environment variable for ffmpeg path
ENV FFMPEG_PATH /usr/local/bin/ffmpeg

# Run the script located in example/example2.js
CMD ["node", "example/example2.js"]
