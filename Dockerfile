# Fetching the minified node image on debian slim
FROM node:slim

# Declaring env
ENV NODE_ENV development

# Setting up the work directory
WORKDIR /gch_robs_itcomed

# Copying all the files in our project
COPY . .

# Installing nano and other dependencies
RUN apt-get update && apt-get install -y nano && rm -rf /var/lib/apt/lists/* \
    && npm install

# Exposing the port
EXPOSE 5682

# Starting our application (ESM entry)
CMD [ "node", "server.mjs" ]
